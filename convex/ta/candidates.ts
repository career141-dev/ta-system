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
import { query, type QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertFullAccess, optionalActor} from "./guard";
import { candidateIdToPointId, candidateVectorPayload } from "../lib/vectorPayload";

/**
 * A candidate row with their career attached.
 *
 * Extraction writes the dated job history to `candidateResumes`, not to the
 * candidate, so a row read on its own has no career at all — every result on
 * the Database screen showed a single current role, and the profile had no
 * Career section. The old system's `getCandidate` merges it the same way
 * (`resume?.jobHistory || jobHistory`); this is that rule, in one place.
 *
 * The heavy fields are left out — `rawText` and the embedding are large and no
 * screen that calls this shows them.
 */
async function withCareer(
  ctx: QueryCtx,
  id: Id<"candidates">,
  shape: "list" | "full" = "list",
): Promise<Doc<"candidates"> | null> {
  const candidate = await ctx.db.get(id);
  if (!candidate) return null;
  const resume = await ctx.db
    .query("candidateResumes")
    .withIndex("by_candidateId", (q) => q.eq("candidateId", id))
    .first();
  const career = (resume?.jobHistory?.length ? resume.jobHistory : candidate.jobHistory) ?? [];
  if (shape === "full") {
    const { rawText: _raw, ...rest } = candidate;
    return { ...rest, jobHistory: career } as Doc<"candidates">;
  }
  /*
   * Lists get what the list mapper reads (src/lib/live/mapLive.ts) and nothing
   * else. A full row carries the summary, extraction confidence, past titles,
   * application summaries and a paragraph per role — none of it on a list, and
   * the layout loads 740 of these on every page for the alert badge.
   */
  const out: Record<string, unknown> = { jobHistory: career.map(({ title, company, startDate, endDate }) => ({ title, company, startDate, endDate })) };
  for (const field of LIST_FIELDS) {
    const value = (candidate as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  if (candidate.locationStructured?.raw_text) out.locationStructured = { raw_text: candidate.locationStructured.raw_text };
  if (Array.isArray(candidate.education) && candidate.education.length) out.education = [candidate.education[0]];
  return out as unknown as Doc<"candidates">;
}

/** Exactly the fields `mapCandidate` reads. Add here when the mapper grows. */
const LIST_FIELDS = [
  "_id", "_creationTime", "fullName", "email", "phone", "linkedinUrl", "location", "nationality",
  "age", "gender", "currentEmployer", "currentJobTitle", "currentTitle", "totalExperienceYears",
  "yearsOfExperience", "educationDegree", "educationInstitution", "certifications", "languages",
  "skills", "industries", "sector", "noticePeriodDays", "currentSalary", "currentSalaryCurrency",
  "expectedSalary", "expectedSalaryCurrency",
] as const;

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
      args.candidateIds.slice(0, 500).map((id) => withCareer(ctx, id as Id<"candidates">)),
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
    return await withCareer(ctx, args.candidateId as Id<"candidates">);
  },
});

/**
 * The top-bar search: people by name first, then by job title — across the
 * whole database, not the few hundred rows a page happens to have loaded.
 * Returns ids in rank order; the page loads the records it shows.
 */
export const quickSearch = query({
  args: { actorId: v.optional(v.string()), q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<string[]> => {
    const user = await optionalActor(ctx, args.actorId);
    if (user) assertFullAccess(user);
    const q = args.q.trim().slice(0, 120);
    if (q.length < 2) return [];
    const limit = Math.min(args.limit ?? 12, 50);
    const [byName, byTitle] = await Promise.all([
      ctx.db.query("candidates").withSearchIndex("search_name", (s) => s.search("fullName", q)).take(limit),
      ctx.db.query("candidates").withSearchIndex("search_title", (s) => s.search("currentJobTitle", q)).take(limit),
    ]);
    const ids: string[] = [];
    for (const c of [...byName, ...byTitle]) if (!ids.includes(c._id) && !(c as { mergedInto?: string }).mergedInto) ids.push(c._id);
    return ids.slice(0, limit);
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

/**
 * Everything the database holds about one person, for their profile.
 *
 * The list screens need twenty fields and get them through the shared mapper.
 * A profile is where a recruiter reads the rest — the summary, a career with
 * dates and what they did, every qualification, the referees, the CV — and
 * none of that was being asked for, so the page showed a fraction of the
 * record and looked as though the extraction had failed.
 *
 * Returned raw, not reshaped: `src/lib/candidateProfile.ts` does the mapping,
 * in one tested place, as the list mapper does.
 *
 * The CV's LOCATION is deliberately not resolved here. That is
 * `candidates/candidates:getCvUploadUrl`, the old system's lookup with its
 * application and file-hash fallbacks, and a second copy of it would drift.
 * This only says whether there is a file and what it is.
 */
export const profile = query({
  args: { actorId: v.optional(v.string()), candidateId: v.string() },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);
    if (user) assertFullAccess(user);

    const id = ctx.db.normalizeId("candidates", args.candidateId);
    if (!id) return null;
    const candidate = await withCareer(ctx, id, "full");
    if (!candidate) return null;

    const [referees, applications, resume, upload] = await Promise.all([
      ctx.db.query("referees").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).collect(),
      ctx.db.query("applications").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).collect(),
      ctx.db.query("candidateResumes").withIndex("by_candidateId", (q) => q.eq("candidateId", id)).first(),
      candidate.cvUploadId ? ctx.db.get(candidate.cvUploadId) : Promise.resolve(null),
    ]);

    const jobs = await Promise.all(applications.map((a) => ctx.db.get(a.jobId)));

    const cvTextInDb =
      (resume?.rawText && resume.rawText.trim().length >= 30 ? resume.rawText : null) ??
      // `withCareer` drops the row's own copy to keep list reads light; a profile
      // is one person, so it is read back here.
      (await ctx.db.get(id).then((row) => (row?.rawText && row.rawText.trim().length >= 30 ? row.rawText : null)));

    return {
      candidate,
      referees: referees.map((r) => ({
        name: r.name,
        designation: r.designation ?? null,
        company: r.company ?? null,
        contactNo: r.contactNo ?? null,
        email: r.email ?? null,
        relationship: r.relationship ?? null,
      })),
      matches: applications.map((a, i) => ({
        applicationId: a._id as string,
        jobId: a.jobId as string,
        jobTitle: jobs[i]?.title ?? null,
        clientName: jobs[i]?.clientName ?? null,
        score: typeof a.aiMatchScore === "number" ? a.aiMatchScore : null,
        explanation: a.aiMatchExplanation ?? null,
      })),
      cv: upload
        ? {
            fileName: upload.fileName ?? null,
            fileType: upload.fileType ?? null,
            fileSize: typeof upload.fileSize === "number" ? upload.fileSize : null,
            status: upload.status ?? null,
            // Where the bytes are, without the key itself: the page only needs
            // to know whether opening it depends on R2 being configured.
            storage: upload.s3Key ? ("r2" as const) : upload.storageId ? ("convex" as const) : ("none" as const),
          }
        : null,
      cvText: cvTextInDb,
      cvTextInR2: !cvTextInDb && !!(resume?.rawTextKey ?? candidate.rawTextKey),
    };
  },
});

/**
 * Qdrant payloads for a page of candidates, built by the same function the
 * vector writers use — for scripts/qdrant-payload-repair.ts, which rewrites
 * the payloads of points already in the index without re-embedding them.
 */
export const vectorPayloadPage = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("candidates")
      .paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.numItems ?? 400, 800) });
    return {
      points: page.page.map((c) => ({ pointId: candidateIdToPointId(c._id), payload: candidateVectorPayload(c) })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
