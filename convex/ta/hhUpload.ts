// convex/ta/hhUpload.ts
//
// "Upload headhunted CV", pressed on an opening's TA Follow-up (28 Sep).
//
// A headhunted person's CV had no way in: pasted intake text read only a few
// fields and filed them as E, and the candidate-page upload needs somebody who
// is already on the opening. This hands the file to the CV platform's own
// pipeline — the same extraction every uploaded CV gets (cvs/cvExtraction.ts:
// work history, education, skills, salary, notice, referees, duplicate
// checks), filed on this opening through `assignToJob`. Nothing here reads a
// CV. The only new step is `fileHeadhunt`, which the pipeline calls once the
// application exists: the TA who uploaded it claims them into TA Follow-up,
// flagged HH, and they are logged on the opening's headhunting sheet.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireActor, assertJobAccess, optionalActor, WORKS_THE_DESK } from "./guard";
import { claimForTa } from "./applications";
import { toTaStage } from "./stages";
import { assertWorkdayScope } from "../lib/workdayScope";
import { profileSlug } from "../lib/samePerson";

/** The channel the pipeline records; the TA System reads it as HH (src/data/convex/map.ts). */
export const HEADHUNT_CHANNEL = "headhunting";

/** One stored file, queued on the existing extraction for this opening. */
export const queue = internalMutation({
  args: {
    actorId: v.string(),
    openingId: v.string(),
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

    // As cvs/cvUploads.ts saveUpload + queueManualExtraction, in one step.
    const cvUploadId = await ctx.db.insert("cvUploads", {
      storageId: args.storageId,
      storageProvider: "convex",
      fileName: args.fileName,
      fileSize: args.fileSize,
      fileType: args.fileType,
      source: "Headhunting",
      assignToJob: job._id as string,
      uploadedBy: user._id as string,
      headhuntedBy: user._id,
      status: "uploaded",
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
    await ctx.scheduler.runAfter(0, internal.cvs.cvExtraction.processCvExtraction, {
      storageId: args.storageId,
      storageProvider: "convex",
      fileType: args.fileType,
      sourceChannel: HEADHUNT_CHANNEL,
      uploadedBy: user._id as string,
      cvUploadId,
      logId,
    });
    return { cvUploadId: cvUploadId as string };
  },
});

/**
 * Called by the extraction once it has filed the CV on the opening. Does
 * nothing for an ordinary upload. For a headhunted one: flag it HH, claim it
 * for the TA who uploaded it (TA Follow-up, with a set number — the same rule
 * as Shortlist), and log them on the headhunting sheet as "CV received".
 */
export const fileHeadhunt = internalMutation({
  args: { cvUploadId: v.id("cvUploads"), candidateId: v.id("candidates"), jobId: v.string() },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.cvUploadId);
    if (!upload?.headhuntedBy) return { handled: false };
    const user = await ctx.db.get(upload.headhuntedBy);
    const jobId = ctx.db.normalizeId("jobs", args.jobId);
    if (!user || !jobId) return { handled: false };

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

    // Owner first, as ta/scoopUpload.ts does. A refused claim used to still
    // relabel the owner's candidate HH and log them on the uploader's sheet
    // as "CV received" — the owner's channel and the uploader's counts both
    // went wrong (2 Oct).
    if (app.ownerTaId && app.ownerTaId !== user._id) {
      const owner = await ctx.db.get(app.ownerTaId);
      await ctx.db.patch(upload._id, {
        routeNote: `Already claimed on this opening by ${owner?.fullName ?? "another TA"}.`,
      });
      return { handled: true, claimed: false };
    }
    await ctx.db.patch(app._id, { taSourcingChannel: "HH" });
    const claimed = await claimForTa(ctx, user, app);
    if (!claimed.ok) {
      // Cannot happen inside this transaction after the check above; kept so
      // a change to claimForTa's rule still reports rather than files.
      const owner = await ctx.db.get(claimed.ownerTaId as Id<"users">);
      await ctx.db.patch(upload._id, {
        routeNote: `Already claimed on this opening by ${owner?.fullName ?? "another TA"}.`,
      });
      return { handled: true, claimed: false };
    }

    // On the headhunting sheet, so its counts include this person.
    const rows = await ctx.db
      .query("linkVault")
      .withIndex("by_opening", (q) => q.eq("openingId", jobId))
      .collect();
    const slug = profileSlug(candidate.linkedinUrl);
    // A marked row can still hold only a LinkedIn URL when its requested CV arrives (13 Oct).
    // Match an exact profile on the uploader's sheet, never another TA's or a name alone.
    const linked = rows.find((r) => r.candidateId === candidate._id);
    const profiles = slug ? rows.filter((r) => !r.candidateId && r.addedBy === user._id && profileSlug(r.linkedinUrl) === slug) : [];
    const row = linked ?? (profiles.length === 1 ? profiles[0] : undefined);
    if (row) {
      if (!row.candidateId) await ctx.db.patch(row._id, { candidateId: candidate._id });
      if (row.outcome !== "shortlisted" && row.outcome !== "cv_received") {
        await ctx.db.patch(row._id, { outcome: "cv_received" });
      }
    } else {
      await ctx.db.insert("linkVault", {
        openingId: jobId,
        addedBy: user._id,
        linkedinUrl: candidate.linkedinUrl ?? "",
        name: candidate.fullName ?? null,
        title: candidate.currentTitle ?? candidate.currentJobTitle ?? null,
        company: candidate.currentEmployer ?? null,
        isEyeMarked: false,
        phoneNumber: candidate.phone ?? null,
        phoneSource: candidate.phone ? "internal_db" : null,
        sourcingChannel: "HH",
        outcome: "cv_received",
        candidateId: candidate._id,
        conversationLog: [],
        createdAt: Date.now(),
      } as never);
    }
    return { handled: true, claimed: claimed.ok };
  },
});

/** Where each uploaded file has got to, for the panel on TA Follow-up. */
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
      const failed = upload.status === "failed";
      const mine = !!app && app.ownerTaId === upload.headhuntedBy;
      const state = failed
        ? ("failed" as const)
        : mine
          ? ("done" as const)
          : app && upload.routeNote
            ? ("held" as const)
            : ("reading" as const);
      out.push({
        id: raw,
        state,
        fileName: upload.fileName,
        name: candidate?.fullName ?? null,
        applicationId: app ? (app._id as string) : null,
        stage: app ? toTaStage(app.currentStage) : null,
        note: failed ? (upload.errorMessage ?? "The CV could not be read.") : (upload.routeNote ?? null),
      });
    }
    return out;
  },
});
