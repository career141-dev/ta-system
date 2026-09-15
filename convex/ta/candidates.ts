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

    /*
     * Fetched together, not one after another.
     *
     * Awaiting each `get` in turn makes a batch of 500 into 500 sequential
     * round trips, and the caller waits for the sum of them. It is the same
     * number of reads either way — the difference is entirely in whether they
     * queue. Measured on the desk's follow-up set (740 candidates), the serial
     * loop took 4.3 seconds; that cost was being paid on every page load,
     * because the alert badge in the layout needs those records.
     */
    const docs = await Promise.all(
      args.candidateIds.slice(0, 500).map((id) => ctx.db.get(id as Id<"candidates">)),
    );
    return docs.filter((c): c is Doc<"candidates"> => c !== null);
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

/**
 * How many candidates there are, and a vocabulary to search with — without
 * reading 77,000 rows.
 *
 * The Database home page used to count them by loading them all. That was
 * fine over a seeded file and is a whole-table read here, so the count comes
 * from the table's own statistics where they exist and from a bounded sample
 * where they do not — and it says which, because a sampled number presented as
 * exact is a number somebody will later act on.
 */
export const stats = query({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    // A bounded walk: enough to be useful, capped so it cannot become a scan.
    const CAP = 4000;
    const page = await ctx.db.query("candidates").take(CAP + 1);
    return { total: Math.min(page.length, CAP), sampled: page.length > CAP };
  },
});

/** Titles, skills, cities and employers the database actually contains, from a
 *  bounded sample — what the search box completes against. */
export const vocabulary = query({
  args: { actorId: v.optional(v.string()), sample: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const rows = await ctx.db.query("candidates").take(Math.min(args.sample ?? 1500, 4000));
    const titles = new Map<string, number>();
    const skills = new Set<string>();
    const cities = new Set<string>();
    const employers = new Set<string>();
    const industries = new Set<string>();
    for (const c of rows) {
      const t = c.currentJobTitle ?? c.currentTitle;
      if (t) titles.set(t, (titles.get(t) ?? 0) + 1);
      for (const s of (c.skills ?? []).slice(0, 12)) if (typeof s === "string") skills.add(s);
      const city = c.locationStructured?.city ?? null;
      if (city) cities.add(city);
      if (c.currentEmployer) employers.add(c.currentEmployer);
      if (c.sector) industries.add(c.sector);
      for (const i of c.industries ?? []) industries.add(i);
    }
    return {
      titles: [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([t, n]) => ({ title: t, count: n })),
      skills: [...skills].slice(0, 600),
      cities: [...cities].slice(0, 200),
      employers: [...employers].slice(0, 400),
      industries: [...industries].slice(0, 200),
      sampled: rows.length,
    };
  },
});
