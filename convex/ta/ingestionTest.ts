// convex/ta/ingestionTest.ts
//
// What one CV's arrival left in the database, and taking it away again — for
// the ingestion end-to-end test (scripts/e2e/p3-ingestion.ts). Internal only,
// and the cleanup refuses anything but a test opening ("C141 TEST" client).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const trace = internalQuery({
  args: { fileHashes: v.array(v.string()), jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const out = [];
    for (const fileHash of args.fileHashes) {
      const uploads = await ctx.db.query("cvUploads").withIndex("by_fileHash", (q) => q.eq("fileHash", fileHash)).collect();
      const upload = uploads.sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
      const candidateId = (upload?.candidateId ?? null) as Id<"candidates"> | null;
      const c = candidateId ? await ctx.db.get(candidateId) : null;
      const resume = candidateId
        ? await ctx.db.query("candidateResumes").withIndex("by_candidateId", (q) => q.eq("candidateId", candidateId)).first()
        : null;
      const app = candidateId
        ? await ctx.db.query("applications").withIndex("by_candidate_job", (q) => q.eq("candidateId", candidateId).eq("jobId", args.jobId)).first()
        : null;
      const scores = candidateId
        ? await ctx.db.query("match_scores").withIndex("by_candidate_job", (q) => q.eq("candidateId", candidateId).eq("jobId", args.jobId)).collect()
        : [];
      const logs = upload ? await ctx.db.query("ingestionLog").withIndex("by_cvFileId", (q) => q.eq("cvFileId", upload._id)).collect() : [];
      const cc = c as Record<string, any> | null;
      out.push({
        fileHash,
        uploads: uploads.length,
        upload: upload && {
          id: upload._id, createdAt: upload._creationTime, status: upload.status, errorMessage: upload.errorMessage ?? null,
          s3Key: upload.s3Key ?? null, storageProvider: upload.storageProvider ?? null, assignToJob: upload.assignToJob ?? null,
        },
        candidate: cc && {
          id: cc._id, createdAt: cc._creationTime, fullName: cc.fullName ?? null, hasEmail: !!cc.email, hasPhone: !!cc.phone,
          currentTitle: cc.currentTitle ?? null, location: cc.location ?? null, isParsed: !!cc.isParsed,
          skills: (cc.skills ?? []).length, jobHistory: (cc.jobHistory ?? resume?.jobHistory ?? []).length, education: (cc.education ?? []).length,
          totalExperienceYears: cc.totalExperienceYears ?? null, rawTextKey: cc.rawTextKey ?? null, hasEmbedding: !!cc.hasEmbedding,
        },
        resume: !!resume,
        application: app && {
          id: app._id, stage: app.currentStage, isActive: app.isActive, sourceChannel: app.sourceChannel ?? null,
          aiMatchScore: (app as any).aiMatchScore ?? null, explanation: String((app as any).aiMatchExplanation ?? "").slice(0, 160),
        },
        matchScores: scores.length,
        logStages: logs.map((l) => l.stage),
      });
    }
    return out;
  },
});

/** Remove what the test's CVs created. Rows that existed before `since` are left alone. */
export const cleanup = internalMutation({
  args: { fileHashes: v.array(v.string()), jobId: v.id("jobs"), since: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const client = job?.clientId ? await ctx.db.get(job.clientId) : null;
    if (!job || !String((client as any)?.name ?? job.clientName ?? "").startsWith("C141 TEST")) {
      throw new Error("cleanup only touches a C141 TEST opening");
    }
    const removed: Record<string, number> = {};
    const bump = (k: string) => (removed[k] = (removed[k] ?? 0) + 1);
    const candidates: string[] = [];

    for (const fileHash of args.fileHashes) {
      const uploads = await ctx.db.query("cvUploads").withIndex("by_fileHash", (q) => q.eq("fileHash", fileHash)).collect();
      for (const up of uploads.filter((u) => u._creationTime >= args.since)) {
        const cid = up.candidateId as Id<"candidates"> | undefined;
        const cand = cid ? await ctx.db.get(cid) : null;
        if (cid && cand && cand._creationTime >= args.since) {
          for (const t of ["applications", "match_scores", "candidateResumes", "referees"] as const) {
            const rows = await ctx.db.query(t as any).withIndex("by_candidateId", (q: any) => q.eq("candidateId", cid)).collect();
            for (const r of rows) { await ctx.db.delete(r._id); bump(t); }
          }
          const key = (cand as any).rawTextKey as string | undefined;
          if (key?.startsWith("convex:")) { await ctx.storage.delete(key.slice(7) as Id<"_storage">).catch(() => undefined); bump("rawText"); }
          await ctx.db.delete(cid);
          candidates.push(cid);
          bump("candidates");
        }
        for (const l of await ctx.db.query("ingestionLog").withIndex("by_cvFileId", (q) => q.eq("cvFileId", up._id)).collect()) {
          await ctx.db.delete(l._id); bump("ingestionLog");
        }
        if (up.s3Key?.startsWith("convex:")) { await ctx.storage.delete(up.s3Key.slice(7) as Id<"_storage">).catch(() => undefined); bump("files"); }
        if (up.storageId) { await ctx.storage.delete(up.storageId).catch(() => undefined); bump("files"); }
        await ctx.db.delete(up._id);
        bump("cvUploads");
      }
    }
    // Anything left on the test opening: links to candidates who existed before.
    for (const a of await ctx.db.query("applications").withIndex("by_jobId" as any, (q: any) => q.eq("jobId", args.jobId)).collect()) {
      await ctx.db.delete(a._id); bump("applications");
    }
    for (const s of await ctx.db.query("match_scores").withIndex("by_job_score", (q) => q.eq("jobId", args.jobId)).collect()) {
      await ctx.db.delete(s._id); bump("match_scores");
    }
    for (const l of await ctx.db.query("ingestionLog").withIndex("by_job", (q) => q.eq("jobId", args.jobId)).collect()) {
      await ctx.db.delete(l._id); bump("ingestionLog");
    }
    return { removed, candidates };
  },
});
