import { v } from "convex/values";
import { query, mutation } from "../_generated/server";
import { syncCandidateOverallStatus } from "../candidates/candidates";

export const inspectCandidateApplications = query({
  args: {
    candidateId: v.id("candidates"),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) return { error: "Candidate not found" };

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    const appDetails = await Promise.all(
      apps.map(async (app) => {
        const job = await ctx.db.get(app.jobId);
        return {
          applicationId: app._id,
          jobId: app.jobId,
          jobTitle: job?.title || "Unknown Job",
          currentStage: app.currentStage,
          sourceChannel: app.sourceChannel,
          createdAt: app._creationTime,
        };
      })
    );

    return {
      candidateId: candidate._id,
      fullName: candidate.fullName,
      phone: candidate.phone,
      email: candidate.email,
      totalApplications: appDetails.length,
      applications: appDetails,
    };
  },
});

export const inspectDuplicateCandidatesByPhone = query({
  args: {
    phone: v.string(),
  },
  handler: async (ctx, args) => {
    const cleanDigits = args.phone.replace(/\D/g, "");
    const intlPhone = "+" + cleanDigits;
    
    const byPhone = await ctx.db
      .query("candidates")
      .withIndex("by_phone", (q) => q.eq("phone", intlPhone))
      .collect();

    const byPhoneClean = await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q) => q.eq("phoneClean", cleanDigits))
      .collect();

    const candidateMap = new Map();
    for (const c of [...byPhone, ...byPhoneClean]) {
      candidateMap.set(c._id, c);
    }

    const matchingCandidates = Array.from(candidateMap.values());

    const results = await Promise.all(
      matchingCandidates.map(async (c: any) => {
        const apps = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q: any) => q.eq("candidateId", c._id))
          .collect();

        const appDetails = await Promise.all(
          apps.map(async (app) => {
            const job = await ctx.db.get(app.jobId);
            return {
              applicationId: app._id,
              jobId: app.jobId,
              jobTitle: job?.title || "Unknown Job",
              currentStage: app.currentStage,
            };
          })
        );

        return {
          candidateId: c._id,
          fullName: c.fullName,
          phone: c.phone,
          phoneClean: c.phoneClean,
          createdAt: c._creationTime,
          applications: appDetails,
        };
      })
    );

    return results;
  },
});

export const cleanupExtraCandidatesByPhone = mutation({
  args: {
    phone: v.string(),
    keepCandidateId: v.id("candidates"),
  },
  handler: async (ctx, args) => {
    const cleanDigits = args.phone.replace(/\D/g, "");
    const intlPhone = "+" + cleanDigits;
    
    const byPhone = await ctx.db
      .query("candidates")
      .withIndex("by_phone", (q) => q.eq("phone", intlPhone))
      .collect();

    const byPhoneClean = await ctx.db
      .query("candidates")
      .withIndex("by_phoneClean", (q) => q.eq("phoneClean", cleanDigits))
      .collect();

    const candidateMap = new Map();
    for (const c of [...byPhone, ...byPhoneClean]) {
      candidateMap.set(c._id, c);
    }

    const matchingCandidates = Array.from(candidateMap.values());
    const deleted: string[] = [];

    for (const c of matchingCandidates) {
      if (c._id !== args.keepCandidateId) {
        // Delete duplicate candidate's applications
        const apps = await ctx.db
          .query("applications")
          .withIndex("by_candidateId", (q: any) => q.eq("candidateId", c._id))
          .collect();
        for (const app of apps) {
          await ctx.db.delete(app._id);
        }
        // Delete duplicate candidate record
        await ctx.db.delete(c._id);
        deleted.push(`${c.fullName} (${c._id})`);
      }
    }

    return {
      keptCandidateId: args.keepCandidateId,
      deletedCandidates: deleted,
    };
  },
});

export const keepOnlyTargetJobForCandidate = mutation({
  args: {
    candidateId: v.id("candidates"),
    targetJobTitle: v.string(),
  },
  handler: async (ctx, args) => {
    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) throw new Error("Candidate not found");

    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId))
      .collect();

    const appDetails = await Promise.all(
      apps.map(async (app) => {
        const job = await ctx.db.get(app.jobId);
        return {
          app,
          jobTitle: job?.title || "",
        };
      })
    );

    const kept: string[] = [];
    const deleted: string[] = [];

    for (const item of appDetails) {
      const isTarget = item.jobTitle.toLowerCase().includes(args.targetJobTitle.toLowerCase());
      if (isTarget && kept.length === 0) {
        kept.push(`${item.jobTitle} (${item.app._id})`);
      } else {
        // Delete unwanted extra job application for this candidate
        await ctx.db.delete(item.app._id);
        deleted.push(`${item.jobTitle} (${item.app._id})`);
      }
    }

    // Sync candidate overall status post deletion
    await syncCandidateOverallStatus(ctx, args.candidateId);

    return {
      candidateName: candidate.fullName,
      keptApplications: kept,
      deletedApplications: deleted,
    };
  },
});
