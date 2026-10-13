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
import { assertWorkdayScope } from "../lib/workdayScope";

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
    await assertWorkdayScope(ctx, user, app.jobId);
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
      // Only the file is replaced (29 Sep). Naming the candidate stops the
      // extraction making a new one and merging it over this person; the flag
      // makes it fill only what is empty (convex/lib/fillBlanks.ts).
      candidateId: candidate._id,
      replaceKeepDetails: true,
    });
    // The earlier upload stays in cvUploads: replacing the CV on file does
    // not delete what was there.
    const previous = candidate.cvUploadId ?? null;
    await ctx.db.patch(candidate._id, { cvUploadId: uploadId, cvFileName: args.fileName } as never);
    // Brought in by someone other than the owner — a support TA — it is their
    // scoop, and counts on their end-of-day L-sheet (plan 6.4).
    const scoop = app.ownerTaId && (app.ownerTaId as string) !== (user._id as string);
    await ctx.db.patch(appId, {
      cvFileId: uploadId,
      cvFileName: args.fileName,
      ...(scoop ? { scoopByUserId: user._id as string, scoopAt: Date.now() } : {}),
    } as never);
    return { uploadId: uploadId as string, replaced: previous !== null };
  },
});
