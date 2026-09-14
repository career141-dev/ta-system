// convex/ta/candidates.ts
//
// Candidates, in the shape src/data/types.ts describes.
//
// The mapping itself already exists and is tested — src/lib/live/mapLive.ts —
// so this deliberately does NOT re-implement it. What it does is return the
// raw fields that mapping needs, in batches, so the app can map once on its
// own side. Two copies of a field-mapping drift; one does not.
//
// CV text is the awkward part: newer extractions write only `rawTextKey` (an
// R2 object), so the text is not in the database at all. `cvText` reports
// which of the two it found rather than returning an empty string, because
// "no text" and "text lives in R2" need different handling upstream.

import { v } from "convex/values";
import { query } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertFullAccess, optionalActor} from "./guard";

export const getBatch = query({
  args: { actorId: v.optional(v.string()), candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);
    // Only meaningful when a person was named; an unnamed caller holds the
    // admin key, which already permits everything here.
    if (user) assertFullAccess(user);

    const out: Doc<"candidates">[] = [];
    for (const id of args.candidateIds.slice(0, 500)) {
      const c = await ctx.db.get(id as Id<"candidates">);
      if (c) out.push(c);
    }
    return out;
  },
});

export const get = query({
  args: { actorId: v.optional(v.string()), candidateId: v.string() },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);
    // Only meaningful when a person was named; an unnamed caller holds the
    // admin key, which already permits everything here.
    if (user) assertFullAccess(user);
    return await ctx.db.get(args.candidateId as Id<"candidates">);
  },
});

/** Every application this person has ever been on, across all openings. This
 *  is what the "rejected on two previous openings" warning is built from. */
export const applicationsFor = query({
  args: { actorId: v.optional(v.string()), candidateId: v.string() },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_candidateId", (q) => q.eq("candidateId", args.candidateId as Id<"candidates">))
      .collect();

    const out = [];
    for (const a of apps) {
      const job = await ctx.db.get(a.jobId);
      out.push({
        id: a._id as string,
        openingId: a.jobId as string,
        openingTitle: job?.title ?? "(deleted job)",
        clientName: job?.clientName ?? null,
        stage: a.currentStage,
        ownerTaId: (a.ownerTaId ?? null) as string | null,
        isActive: a.isActive,
        lastStageChangedAt: a.lastStageChangedAt,
      });
    }
    return out;
  },
});

/**
 * The CV text for a set of candidates, and where it came from.
 *
 * `source` is the useful part: "db" means the text is here, "r2" means it
 * exists but only as an object in storage and fetching it needs an action,
 * and "none" means there is no text at all. A caller that treats all three as
 * an empty string will quietly score people on nothing.
 */
export const cvText = query({
  args: { actorId: v.optional(v.string()), candidateIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);
    // Only meaningful when a person was named; an unnamed caller holds the
    // admin key, which already permits everything here.
    if (user) assertFullAccess(user);

    const out: { candidateId: string; source: "db" | "r2" | "none"; text: string | null; key: string | null }[] = [];
    for (const id of args.candidateIds.slice(0, 200)) {
      const resume = await ctx.db
        .query("candidateResumes")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", id as Id<"candidates">))
        .first();

      if (resume?.rawText && resume.rawText.trim().length >= 30) {
        out.push({ candidateId: id, source: "db", text: resume.rawText, key: null });
      } else if (resume?.rawTextKey) {
        out.push({ candidateId: id, source: "r2", text: null, key: resume.rawTextKey });
      } else {
        out.push({ candidateId: id, source: "none", text: null, key: null });
      }
    }
    return out;
  },
});
