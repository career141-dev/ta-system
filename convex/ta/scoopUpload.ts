// convex/ta/scoopUpload.ts
//
// "Scoops" on an opening (29 Sep). The Director / a TA Lead sends scoop CVs to
// the TA; the TA uploads them here instead of the system reading their mailbox.
//
// As the headhunted-CV upload (ta/hhUpload.ts): the file goes through the CV
// platform's own extraction for this opening — nothing here reads a CV. The
// one extra step is `fileScoop`, which the pipeline calls once the application
// exists (including for a CV already in the database) and which flags it as a
// scoop. The end-of-day SCOOP column counts a scoop once it is sent to the
// Director (src/lib/eod.ts), so nothing else changes there.

import { v } from "convex/values";
import { assertWorkdayScope } from "../lib/workdayScope";
import { internalMutation, internalQuery } from "../_generated/server";
import { enqueueExtraction } from "../cvs/cvUploads";
import type { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, optionalActor, WORKS_THE_DESK } from "./guard";
import { toTaStage } from "./stages";
import { isScoopSender, scoopFlag } from "../lib/scoopMail";
import { uploadProgress } from "../lib/cvUploadProgress";

/** The pipeline's channel name for it; it reads as E in the TA System, like any uploaded CV. */
export const SCOOP_CHANNEL = "scoop";

/** One stored file, queued on the existing extraction for this opening. */
export const queue = internalMutation({
  args: {
    actorId: v.string(),
    openingId: v.string(),
    fromUserId: v.optional(v.string()),
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileSize: v.number(),
    fileType: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const jobId = ctx.db.normalizeId("jobs", args.openingId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job) throw new Error("That opening no longer exists.");
    await assertJobAccess(ctx, user, job._id, WORKS_THE_DESK);
    await assertWorkdayScope(ctx, user, job._id);

    // The lead who sent it is optional, but if named it has to be one of them.
    let fromUserId: Id<"users"> | null = null;
    if (args.fromUserId) {
      fromUserId = ctx.db.normalizeId("users", args.fromUserId);
      const from = fromUserId ? await ctx.db.get(fromUserId) : null;
      if (!from || !isScoopSender(from)) throw new Error("Scoops come from the Director, a TA Lead or Ops.");
    }

    const cvUploadId = await ctx.db.insert("cvUploads", {
      storageId: args.storageId,
      storageProvider: "convex",
      fileName: args.fileName,
      fileSize: args.fileSize,
      fileType: args.fileType,
      source: "Scoop",
      assignToJob: job._id as string,
      uploadedBy: user._id as string,
      scoopedBy: user._id,
      ...(fromUserId ? { scoopFromUserId: fromUserId } : {}),
      status: "uploaded",
      processingStage: "queued",
      queuedAt: Date.now(),
      stageChangedAt: Date.now(),
    });
    const logId = await ctx.db.insert("ingestionLog", {
      jobId: job._id,
      channelType: "manual_upload",
      routingStatus: "routed",
      cvFileId: cvUploadId,
      receivedAt: Date.now(),
      stage: "queued",
      candidateName: args.fileName,
      rawSender: user._id as string,
    } as never);
    // Straight into the reading line, ahead of background work (26 Oct).
    await enqueueExtraction(ctx, cvUploadId, {
      storageId: args.storageId,
      storageProvider: "convex",
      fileType: args.fileType,
      sourceChannel: SCOOP_CHANNEL,
      uploadedBy: user._id as string,
      cvUploadId,
      logId,
    });
    return { cvUploadId: cvUploadId as string };
  },
});

/**
 * Called by the extraction once it has filed the CV on the opening. Does
 * nothing for an ordinary upload. For a scoop: mark the application (see
 * `scoopFlag`). The TA's own Shortlist then claims it — the owner is not set
 * here, or Shortlist would see "already mine" and skip the move to Follow-up.
 */
export const fileScoop = internalMutation({
  args: { cvUploadId: v.id("cvUploads"), candidateId: v.id("candidates"), jobId: v.string() },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.cvUploadId);
    if (!upload?.scoopedBy) return { handled: false };
    const jobId = ctx.db.normalizeId("jobs", args.jobId);
    if (!jobId) return { handled: false };

    // The pipeline may have folded this person into one already on file.
    let candidate = await ctx.db.get(args.candidateId);
    if (candidate?.mergedInto) candidate = await ctx.db.get(candidate.mergedInto);
    if (!candidate) return { handled: false };
    const app = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
      .filter((q) => q.eq(q.field("jobId"), jobId))
      .first();
    if (!app) return { handled: false };

    const patch = scoopFlag(app, Date.now(), upload.scoopFromUserId ?? null);
    if (patch) await ctx.db.patch(app._id, patch);
    if (app.ownerTaId && app.ownerTaId !== upload.scoopedBy) {
      const owner = await ctx.db.get(app.ownerTaId);
      await ctx.db.patch(upload._id, {
        routeNote: `Already shortlisted on this opening by ${owner?.fullName ?? "another TA"}.`,
      });
    }
    return { handled: true };
  },
});

/** Where each uploaded file has got to, for the panel on the Scoops page. */
export const status = internalQuery({
  args: { actorId: v.optional(v.string()), cvUploadIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const out = [];
    for (const raw of args.cvUploadIds.slice(0, 20)) {
      const id = ctx.db.normalizeId("cvUploads", raw);
      const upload = id ? await ctx.db.get(id) : null;
      if (!upload) {
        out.push({ id: raw, state: "missing" as const, fileName: null, name: null, note: "That upload no longer exists." });
        continue;
      }
      let candidate = upload.candidateId ? await ctx.db.get(upload.candidateId) : null;
      if (candidate?.mergedInto) candidate = await ctx.db.get(candidate.mergedInto);
      const jobId = upload.assignToJob ? ctx.db.normalizeId("jobs", upload.assignToJob) : null;
      const app =
        candidate && jobId
          ? await ctx.db
              .query("applications")
              .withIndex("by_candidateId", (q) => q.eq("candidateId", candidate._id))
              .filter((q) => q.eq(q.field("jobId"), jobId))
              .first()
          : null;
      const businessState = app?.scoopReceivedAt ? (upload.routeNote ? ("held" as const) : ("done" as const)) : null;
      const progress = uploadProgress(upload, businessState);
      out.push({
        id: raw,
        ...progress,
        fileName: upload.fileName,
        name: candidate?.fullName ?? null,
        applicationId: app ? (app._id as string) : null,
        stage: app ? toTaStage(app.currentStage) : null,
        note: progress.state === "failed" ? (upload.errorMessage ?? "The CV could not be read.") : (upload.routeNote ?? null),
      });
    }
    return out;
  },
});
