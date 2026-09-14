// convex/ta/search.ts
//
// The read side of database search, and the saved searches behind it.
//
// The retrieval engine is `matching/search:aiSearch` and it is not
// reimplemented here — it is an action (it embeds, calls Qdrant and may call a
// model), so the TA platform calls it directly. What a *query* can usefully
// add is the part that action does not do: turning a page of candidate ids
// into rows, and holding the searches people keep.
//
// Plan step 7 is what puts this behind the existing Database screens. Until
// then this is the seam, not the feature.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertFullAccess } from "./guard";

/**
 * Candidate rows for a set of ids, in result order.
 *
 * Order is the caller's, not the database's: the ranking came out of the
 * search engine and re-sorting here would throw it away. The projection is
 * deliberately small — a result list shows a line per person, and shipping
 * whole CV text for fifty of them is the difference between a fast screen and
 * a slow one.
 */
export const resultRows = query({
  args: { actorId: v.optional(v.string()), candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    assertFullAccess(user);

    const rows: Record<string, unknown>[] = [];
    for (const id of args.candidateIds.slice(0, 200)) {
      const c = (await ctx.db.get(id as Id<"candidates">)) as Doc<"candidates"> | null;
      if (!c) continue;
      rows.push({
        id: c._id as string,
        fullName: c.fullName ?? null,
        currentTitle: c.currentJobTitle ?? c.currentTitle ?? null,
        currentEmployer: c.currentEmployer ?? null,
        location: c.location ?? null,
        locationStructured: c.locationStructured ?? null,
        totalExperienceYears: c.totalExperienceYears ?? c.yearsOfExperience ?? null,
        skills: c.skills ?? [],
        industries: c.industries ?? (c.sector ? [c.sector] : []),
        educationDegree: c.educationDegree ?? null,
        educationInstitution: c.educationInstitution ?? null,
        certifications: c.certifications ?? [],
        languages: c.languages ?? [],
        noticePeriodDays: c.noticePeriodDays ?? null,
        currentSalary: c.currentSalary ?? null,
        expectedSalary: c.expectedSalary ?? null,
        expectedSalaryCurrency: c.expectedSalaryCurrency ?? null,
        seniorityLevel: c.seniorityLevel ?? null,
        jobHistory: c.jobHistory ?? [],
        email: c.email ?? null,
        phone: c.phone ?? null,
        linkedinUrl: c.linkedinUrl ?? null,
        firstSourceChannel: c.firstSourceChannel ?? null,
        overallStatus: c.overallStatus ?? null,
        createdAt: c._creationTime,
      });
    }

    // Returned in the order asked for, with anything deleted simply absent.
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    return args.candidateIds.map((id) => byId.get(id)).filter(Boolean);
  },
});

/**
 * The live pipeline state of a set of candidates.
 *
 * This is what the result row's signals are built from — "in two live
 * pipelines", "rejected on a previous opening", "placed by us". Putting
 * somebody in front of a client who already turned them down is how an agency
 * loses credibility, so it has to be visible before the approach.
 */
export const pipelineSignals = query({
  args: { actorId: v.optional(v.string()), candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireActor(ctx, args.actorId);

    const out: Record<string, { stage: string; openingId: string; openingTitle: string; clientName: string | null; isActive: boolean }[]> = {};
    for (const id of args.candidateIds.slice(0, 200)) {
      const apps = await ctx.db
        .query("applications")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", id as Id<"candidates">))
        .collect();

      const rows = [];
      for (const a of apps) {
        const job = await ctx.db.get(a.jobId);
        rows.push({
          stage: a.currentStage,
          openingId: a.jobId as string,
          openingTitle: job?.title ?? "(deleted job)",
          clientName: job?.clientName ?? null,
          isActive: a.isActive,
        });
      }
      out[id] = rows;
    }
    return out;
  },
});

// ─── Saved searches ──────────────────────────────────────────────────────────

export const savedSearches = query({
  args: { actorId: v.optional(v.string()), ownerOnly: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const all = await ctx.db.query("savedSearches").collect();
    const rows = args.ownerOnly ? all.filter((s) => s.ownerId === user._id) : all;
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows.map((s) => ({
      id: s._id as string,
      name: s.name,
      query: s.query,
      mode: s.mode,
      ownerId: s.ownerId as string,
      mine: s.ownerId === user._id,
      openingId: (s.openingId ?? null) as string | null,
      createdAt: s.createdAt,
      lastRunAt: s.lastRunAt ?? null,
      lastResultCount: s.lastResultCount ?? null,
    }));
  },
});

export const saveSearch = mutation({
  args: {
    actorId: v.optional(v.string()),
    name: v.string(),
    query: v.string(),
    mode: v.union(v.literal("natural"), v.literal("boolean"), v.literal("meaning")),
    openingId: v.optional(v.union(v.string(), v.null())),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const id = await ctx.db.insert("savedSearches", {
      name: args.name,
      query: args.query,
      mode: args.mode,
      ownerId: user._id,
      openingId: (args.openingId ?? null) as Id<"jobs"> | null,
      createdAt: Date.now(),
      lastRunAt: Date.now(),
      lastResultCount: args.count ?? null,
    });
    return { id: id as string };
  },
});

export const deleteSearch = mutation({
  args: { actorId: v.optional(v.string()), searchId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActor(ctx, args.actorId);
    const row = await ctx.db.get(args.searchId as Id<"savedSearches">);
    if (!row) return { ok: true };
    // Deleting somebody else's saved search is not a thing a desk should allow
    // by accident, so it is refused rather than ignored.
    if (row.ownerId !== user._id && !["admin", "ta_manager"].includes(user.role)) {
      throw new Error("That saved search belongs to somebody else.");
    }
    await ctx.db.delete(row._id);
    return { ok: true };
  },
});
