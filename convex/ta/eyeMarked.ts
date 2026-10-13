import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { requireActor, assertJobAccess, isTaOnOwnDesk, WORKS_THE_DESK } from "./guard";
import { toTaStage } from "./stages";
import { eyeMarkedProgress } from "../../src/lib/eyeMarked";
import { cvFileMissing } from "../../src/lib/cvMissing";
import type { LinkOutcome } from "../../src/data/types";

/** Read the database immediately before dispatch; a cached Next page cannot bypass the requirement. */
export const checkEmail = internalQuery({
  args: { actorId: v.string(), openingId: v.id("jobs") },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    await assertJobAccess(ctx, user, args.openingId, WORKS_THE_DESK);
    if (!isTaOnOwnDesk(user)) return { ok: true, outstanding: 0 };
    const rows = (await ctx.db.query("linkVault").withIndex("by_opening", (q) => q.eq("openingId", args.openingId)).collect())
      .filter((r) => r.isEyeMarked && r.addedBy === user._id);
    const apps = await ctx.db.query("applications").withIndex("by_jobId", (q) => q.eq("jobId", args.openingId)).collect();
    const rounds = await ctx.db.query("reviewRounds").withIndex("by_opening_kind", (q) => q.eq("openingId", args.openingId).eq("kind", "director")).collect();
    const sent = new Set(rounds.flatMap((r) => r.applicationIds));
    let outstanding = 0;
    for (const row of rows) {
      const candidate = row.candidateId ? await ctx.db.get(row.candidateId) : null;
      const app = apps.find((a) => a.candidateId === row.candidateId);
      const progress = eyeMarkedProgress(
        { id: row._id, name: row.name ?? null, linkedinUrl: row.linkedinUrl, outcome: row.outcome as LinkOutcome, conversationLog: row.conversationLog },
        app ? { id: app._id, stage: toTaStage(app.currentStage), cvFileId: app.cvFileId } : undefined,
        candidate ? { fullName: candidate.fullName ?? "", cvFileName: candidate.cvFileName || (candidate.cvUploadId ? "CV on file" : null), cvFileMissing: cvFileMissing(candidate) } : undefined,
        !!app && sent.has(app._id),
      );
      if (progress.blocked) outstanding++;
    }
    return { ok: outstanding === 0, outstanding };
  },
});
