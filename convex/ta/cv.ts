// convex/ta/cv.ts
//
// A CV added by hand to someone already on an opening (21 Sep).
//
// The only way a CV got in was intake, which matches or creates a candidate by
// itself. A headhunted person — found on LinkedIn, talked to on the phone —
// had no CV and nowhere to put one, so Director review refused them for good.
// These attach the file to that candidate and that application, and nothing
// else: no new candidate, no matching.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, WORKS_THE_DESK } from "./guard";

/** Where to put the file. The web app uploads it straight to storage. */
export const uploadUrl = internalMutation({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);
    return await ctx.storage.generateUploadUrl();
  },
});

/** The stored file, as this candidate's CV on file and this application's. */
export const attach = internalMutation({
  args: {
    actorId: v.optional(v.string()),
    applicationId: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileSize: v.number(),
    fileType: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const appId = args.applicationId as Id<"applications">;
    const app = await ctx.db.get(appId);
    if (!app) throw new Error("That application no longer exists.");
    await assertJobAccess(ctx, user, app.jobId, WORKS_THE_DESK);
    const candidate = await ctx.db.get(app.candidateId);
    if (!candidate) throw new Error("That candidate no longer exists.");

    const uploadId = await ctx.db.insert("cvUploads", {
      storageId: args.storageId,
      storageProvider: "convex",
      fileName: args.fileName,
      fileSize: args.fileSize,
      fileType: args.fileType,
      source: "Manual",
      uploadedBy: user._id as string,
      status: "uploaded",
    });
    // The earlier upload stays in cvUploads: replacing the CV on file does
    // not delete what was there.
    const previous = candidate.cvUploadId ?? null;
    await ctx.db.patch(candidate._id, { cvUploadId: uploadId, cvFileName: args.fileName } as never);
    await ctx.db.patch(appId, { cvFileId: uploadId, cvFileName: args.fileName } as never);
    return { uploadId: uploadId as string, replaced: previous !== null };
  },
});
