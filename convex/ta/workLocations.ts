import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireActor, assertJobAccess, isDeskWideUser } from "./guard";
import { requireWorkLocation } from "../../src/lib/workLocations";

/** Explicit assignment is atomic with the application's linked sourcing rows. */
export const assign = internalMutation({
  args: { actorId: v.string(), jobId: v.id("jobs"), locationId: v.string(), linkId: v.optional(v.id("linkVault")), applicationId: v.optional(v.id("applications")) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!isDeskWideUser(user)) await assertJobAccess(ctx, user, args.jobId, ["primary_recruiter", "supporting_recruiter"]);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found.");
    const location = requireWorkLocation(job, args.locationId);
    if (!location) throw new Error("Set up the job's work locations first.");
    const link = args.linkId ? await ctx.db.get(args.linkId) : null;
    if (args.linkId && (!link || link.openingId !== args.jobId || (!isDeskWideUser(user) && link.addedBy !== user._id))) throw new Error("You can only assign your own sourcing rows.");
    const app = args.applicationId ? await ctx.db.get(args.applicationId) : link?.candidateId ? await ctx.db.query("applications").withIndex("by_candidate_job", q => q.eq("candidateId", link.candidateId!).eq("jobId", args.jobId)).first() : null;
    if (args.applicationId && !app) throw new Error("Application not found.");
    if (app && (app.jobId !== args.jobId || (!isDeskWideUser(user) && app.ownerTaId !== user._id && !(app.ownerTaId === undefined && link?.addedBy === user._id)))) throw new Error("You can only assign your own applications.");
    if (!link && !app) throw new Error("Select a sourcing row or application.");
    const mails = await ctx.db.query("dailyEmails").withIndex("by_job", q => q.eq("jobId", args.jobId)).collect();
    if (mails.some(e => ["sending", "uncertain"].includes(e.status) || e.status === "accepted" && !e.finalizedAt)) throw new Error("An email needs reconciliation. Assign locations after it is resolved.");
    const rounds = app ? await ctx.db.query("reviewRounds").withIndex("by_opening", q => q.eq("openingId", args.jobId)).collect() : [];
    if (app && rounds.some(r => r.applicationIds.includes(app._id))) throw new Error("This candidate has already been sent for review. Keep their location for the email history.");
    const links = app ? (await ctx.db.query("linkVault").withIndex("by_opening", q => q.eq("openingId", args.jobId)).collect()).filter(r => r.candidateId === app.candidateId) : link ? [link] : [];
    if (!isDeskWideUser(user) && links.some(l => l.addedBy !== user._id)) throw new Error("Ask the TA Lead to move this shared candidate.");
    if (app) await ctx.db.patch(app._id, { workLocationId: location.id });
    for (const row of links) if (row.workLocationId !== location.id) {
      // Import a source batch once per TA/location, keeping legacy L1 and L2
      // separate without colliding with an existing target location's L1.
      const key = `link_levels:${args.jobId}:${row.addedBy}:${location.id}`;
      const held = await ctx.db.query("taSettings").withIndex("by_key", q => q.eq("key", key)).first();
      const levels = JSON.parse(held?.value ?? "[]") as { at: number; name?: string; deleted?: boolean; importedFrom?: string }[];
      const source = `${row.workLocationId ?? "unassigned"}:${row.level ?? 0}`;
      let index = levels.findIndex(l => !l.deleted && l.importedFrom === source);
      if (index < 0) {
        index = levels.length;
        levels.push({ at: Date.now(), ...(row.level ? { name: `Imported L${row.level}` } : {}), importedFrom: source });
      }
      if (held) await ctx.db.patch(held._id, { value: JSON.stringify(levels), updatedAt: Date.now() });
      else await ctx.db.insert("taSettings", { key, value: JSON.stringify(levels), updatedAt: Date.now() });
      await ctx.db.patch(row._id, { workLocationId: location.id, level: index + 1 });
    }
    await ctx.db.insert("activityLog", { actorId: user._id, actorName: user.fullName, action: "work_location_assigned", entityType: "job", entityId: args.jobId,
      metadata: { locationId: location.id, applicationId: app?._id, links: links.map(l => ({ id: l._id, from: l.workLocationId })) }, occurredAt: new Date().toISOString() });
    return { ok: true };
  },
});

/** Inventory only. Existing cities/counts are never inferred or backfilled. */
export const inventory = internalQuery({
  args: { actorId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    if (!isDeskWideUser(user)) throw new Error("Only the TA Lead can inventory location setup.");
    const jobs = await ctx.db.query("jobs").collect();
    return jobs.filter(j => !j.workLocations?.length && (j.taLocations?.length ?? 0) > 1).map(j => ({ jobId: j._id, title: j.title, locations: j.taLocations, headcount: j.headcount }));
  },
});
