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

import { liveFacts } from "../lib/candidateFacts";
import { linkedinVariants, phoneKey, profileSlug, samePerson } from "../lib/samePerson";
import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { requireActor, assertFullAccess, optionalActor} from "./guard";
import { candidateIdToPointId, candidateVectorPayload } from "../lib/vectorPayload";
import { isGone } from "../../src/lib/bin";
import { cvFileMissing } from "../../src/lib/cvMissing";

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
  // Age and experience as of today, with where each came from (lib/candidateFacts).
  const facts = liveFacts(candidate, career);
  if (shape === "full") {
    const { rawText: _raw, ...rest } = candidate;
    return { ...rest, ...facts, jobHistory: career } as unknown as Doc<"candidates">;
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
  Object.assign(out, facts);
  if (cvFileMissing(candidate)) out.cvFileMissing = true;
  if (candidate.locationStructured?.raw_text) out.locationStructured = { raw_text: candidate.locationStructured.raw_text };
  if (Array.isArray(candidate.education) && candidate.education.length) out.education = [candidate.education[0]];
  return out as unknown as Doc<"candidates">;
}

/** Exactly the fields `mapCandidate` reads. Add here when the mapper grows. */
const LIST_FIELDS = [
  "_id", "_creationTime", "fullName", "email", "phone", "linkedinUrl", "location", "nationality",
  "age", "gender", "currentEmployer", "currentJobTitle", "currentTitle", "totalExperienceYears",
  "yearsOfExperience", "educationDegree", "educationInstitution", "certifications", "languages",
  "skills", "industries", "sector", "noticePeriodDays", "noticePeriod", "availability", "currentSalary", "currentSalaryCurrency",
  "expectedSalary", "expectedSalaryCurrency", "taCurrentSalaryText", "taExpectedSalaryText", "currentSalaryNote", "expectedSalaryNote", "cvFileName",
] as const;

export const getBatch = internalQuery({
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

export const get = internalQuery({
  args: { actorId: v.optional(v.string()), candidateId: v.string() },
  handler: async (ctx, args) => {
    const user = await optionalActor(ctx, args.actorId);
    // Only meaningful when a person was named; an unnamed caller holds the
    // admin key, which already permits everything here.
    if (user) assertFullAccess(user);
    return await withCareer(ctx, args.candidateId as Id<"candidates">, "full");
  },
});


/**
 * The top-bar search: people by name first, then by job title — across the
 * whole database, not the few hundred rows a page happens to have loaded.
 * Returns ids in rank order; the page loads the records it shows.
 */
export const quickSearch = internalQuery({
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
    for (const c of [...byName, ...byTitle]) if (!ids.includes(c._id) && !(c as { mergedInto?: string }).mergedInto && !cvFileMissing(c)) ids.push(c._id);
    return ids.slice(0, limit);
  },
});

/** Every application this person has ever been on, across all openings. This
 *  is what the "rejected on two previous openings" warning is built from. */
export const applicationsFor = internalQuery({
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
      // An opening in the Bin is not part of their history until it is restored.
      if (job && isGone(job)) continue;
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
 * People in the database who work at a given company (e.g. candidate's present employer).
 * Scans candidates by currentEmployer or jobHistory, and referees by company.
 */
export const peopleAtCompany = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    company: v.string(),
    excludeCandidateId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const needle = args.company.trim().toLowerCase();
    if (!needle) return { candidates: [], referees: [] };
    const limit = Math.min(args.limit ?? 50, 100);

    const candidates: {
      id: string;
      fullName: string;
      currentTitle: string;
      currentEmployer: string;
      phone: string | null;
      email: string | null;
    }[] = [];

    // By the employer search index, across the whole database. The newest 500
    // alone missed most of 78,000 candidates and said "nobody" when there were
    // people (review of PR #40, 24 Sep). Past employers are not indexed, so
    // this finds people who work there now.
    const candDocs = await ctx.db
      .query("candidates")
      .withSearchIndex("search_employer", (q) => q.search("currentEmployer", args.company.trim()))
      .take(limit * 3);
    for (const cand of candDocs) {
      if (cand.mergedInto) continue;
      if (args.excludeCandidateId && cand._id === args.excludeCandidateId) continue;
      // The index matches words; keep only employers that contain the name.
      const emp = (cand.currentEmployer ?? "").toLowerCase();
      if (emp.includes(needle)) {
        candidates.push({
          id: cand._id as string,
          fullName: cand.fullName ?? "Unnamed Candidate",
          currentTitle: cand.currentJobTitle ?? cand.currentTitle ?? "",
          currentEmployer: cand.currentEmployer ?? (cand.jobHistory?.find((h) => (h.company ?? "").toLowerCase().includes(needle))?.company ?? ""),
          phone: cand.phone ?? null,
          email: cand.email ?? null,
        });
        if (candidates.length >= limit) break;
      }
    }

    const referees: {
      id: string;
      name: string;
      title: string | null;
      company: string | null;
      phone: string | null;
      email: string | null;
      relationship: string | null;
      fromCandidateId: string;
    }[] = [];

    const refDocs = await ctx.db.query("referees").take(500);
    for (const r of refDocs) {
      if (r.company && r.company.toLowerCase().includes(needle)) {
        referees.push({
          id: r._id as string,
          name: r.name,
          title: r.designation ?? null,
          company: r.company ?? null,
          phone: r.contactNo ?? null,
          email: r.email ?? null,
          relationship: r.relationship ?? null,
          fromCandidateId: r.candidateId as string,
        });
        if (referees.length >= limit) break;
      }
    }

    return { candidates, referees };
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
export const cvText = internalQuery({
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
export const stats = internalQuery({
  args: { actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    // The backend's counter, kept by ingestion (stats/statsHelper) and set
    // exactly by scripts/recount-candidates.mjs after an import, which bypasses
    // it. One read. Trusted only once a recount has stamped it.
    const counter = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();
    const stamped = await ctx.db
      .query("taSettings")
      .withIndex("by_key", (q) => q.eq("key", "ta.candidateCountVerifiedAt"))
      .first();
    if (counter && counter.totalCandidates > 0 && stamped) {
      return { total: counter.totalCandidates, sampled: false };
    }
    // A bounded walk: enough to be useful, capped so it cannot become a scan.
    const CAP = 4000;
    const page = await ctx.db.query("candidates").take(CAP + 1);
    return { total: Math.min(page.length, CAP), sampled: page.length > CAP };
  },
});

/**
 * One page of an exact count of the candidates table.
 *
 * Convex keeps no row count and a query has a one-second budget, so the whole
 * table is counted a page at a time by the app (data/convex/backend
 * `candidateTotal`), which keeps the answer for a few minutes. The table's own
 * counter (`systemStats.totalCandidates`) is not used: it had drifted to
 * 47,488 against 77,216 real rows.
 */
export const countPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("candidates")
      .paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.numItems ?? 4000, 8000) });
    return { n: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Sets the candidate counter to an exact count taken with `countPage`, and stamps it as verified. */
export const setCandidateTotal = internalMutation({
  args: { total: v.number() },
  handler: async (ctx, args) => {
    const counter = await ctx.db
      .query("systemStats")
      .withIndex("by_singletonKey", (q) => q.eq("singletonKey", "global_stats"))
      .first();
    if (counter) await ctx.db.patch(counter._id, { totalCandidates: args.total });
    else {
      await ctx.db.insert("systemStats", {
        singletonKey: "global_stats",
        totalCandidates: args.total,
        totalCvUploads: 0,
        totalApplications: 0,
        activeJobsCount: 0,
      });
    }
    const stamp = await ctx.db
      .query("taSettings")
      .withIndex("by_key", (q) => q.eq("key", "ta.candidateCountVerifiedAt"))
      .first();
    const value = new Date().toISOString();
    if (stamp) await ctx.db.patch(stamp._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("taSettings", { key: "ta.candidateCountVerifiedAt", value, updatedAt: Date.now() });
    return { total: args.total };
  },
});

/** Titles, skills, cities and employers the database actually contains, from a
 *  bounded sample — what the search box completes against. */
export const vocabulary = internalQuery({
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
export const profile = internalQuery({
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

    const all = await Promise.all(applications.map((a) => ctx.db.get(a.jobId)));
    // Matches on an opening in the Bin stay hidden until it is restored.
    const kept = applications.map((a, i) => ({ a, job: all[i] })).filter(({ job }) => !(job && isGone(job)));
    const shown = kept.map((k) => k.a);
    const jobs = kept.map((k) => k.job);

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
      matches: shown.map((a, i) => ({
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
export const vectorPayloadPage = internalQuery({
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

/**
 * The candidate a LinkedIn profile belongs to, if we hold them — 28 Sep, so a
 * headhunted person is matched to their existing CV instead of becoming a
 * second record (lib/samePerson has the rules and why).
 *
 * Looked up across the whole database, not only the candidates an opening has
 * loaded: by LinkedIn address in every way it is written, by email, by phone,
 * and by name through the name search; each one found is then judged by
 * samePerson with their whole career. Returns the certain match if there is
 * one, else the best possible one for a TA to confirm, else null.
 */
export const findSamePerson = internalQuery({
  args: {
    actorId: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    location: v.optional(v.string()),
    /** People a TA already said are someone else. */
    notThese: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) => {
    await optionalActor(ctx, a.actorId);
    const found = new Map<string, Doc<"candidates">>();
    const add = (c: Doc<"candidates"> | null) => {
      if (c && !c.mergedInto && !c.isDuplicateOf) found.set(c._id, c);
    };

    const slug = profileSlug(a.linkedinUrl);
    if (slug) {
      for (const url of linkedinVariants(slug)) {
        add(await ctx.db.query("candidates").withIndex("by_linkedinUrl", (q) => q.eq("linkedinUrl", url)).first());
      }
    }
    const email = (a.email ?? "").trim().toLowerCase();
    if (email) add(await ctx.db.query("candidates").withIndex("by_email", (q) => q.eq("email", email)).first());
    const phone = phoneKey(a.phone);
    if (phone) {
      for (const p of [phone, `0${phone}`, `94${phone}`]) {
        add(await ctx.db.query("candidates").withIndex("by_phoneClean", (q) => q.eq("phoneClean", p)).first());
      }
    }
    if ((a.name ?? "").trim().length >= 3) {
      for (const c of await ctx.db.query("candidates").withSearchIndex("search_name", (q) => q.search("fullName", a.name!)).take(15)) add(c);
    }

    const skip = new Set(a.notThese ?? []);
    let best: { c: Doc<"candidates">; strength: "same" | "possible"; reasons: string[] } | null = null;
    for (const c of found.values()) {
      if (skip.has(c._id)) continue;
      const resume = await ctx.db
        .query("candidateResumes")
        .withIndex("by_candidateId", (q) => q.eq("candidateId", c._id))
        .first();
      const career = (resume?.jobHistory?.length ? resume.jobHistory : c.jobHistory) ?? [];
      const verdict = samePerson(
        { linkedinUrl: a.linkedinUrl, name: a.name, email: a.email, phone: a.phone, company: a.company, title: a.title, location: a.location },
        {
          fullName: c.fullName,
          linkedinUrl: c.linkedinUrl,
          email: c.email,
          phone: c.phone,
          currentEmployer: c.currentEmployer,
          currentTitle: c.currentJobTitle ?? c.currentTitle,
          location: c.location ?? c.locationStructured?.raw_text,
          employers: career.map((j) => j.company),
        },
      );
      if (verdict.strength === "none") continue;
      if (!best || (verdict.strength === "same" && best.strength === "possible")) best = { c, strength: verdict.strength, reasons: verdict.reasons };
      if (best.strength === "same") break;
    }
    if (!best) return null;
    const c = best.c;
    return {
      candidateId: c._id as string,
      fullName: c.fullName ?? "",
      currentTitle: c.currentJobTitle ?? c.currentTitle ?? null,
      currentEmployer: c.currentEmployer ?? null,
      strength: best.strength,
      reasons: best.reasons,
      hasCv: Boolean(c.cvUploadId || c.cvFileName || c.rawTextKey || c.rawText),
    };
  },
});

/**
 * Their LinkedIn address, onto the record we matched them to, when it has
 * none — so the next time this profile turns up it is matched at once.
 * Never replaces an address already there.
 */
export const rememberLinkedin = internalMutation({
  args: { actorId: v.optional(v.string()), candidateId: v.string(), linkedinUrl: v.string() },
  handler: async (ctx, a) => {
    await requireActor(ctx, a.actorId);
    const c = await ctx.db.get(a.candidateId as Id<"candidates">);
    if (!c || c.linkedinUrl || !profileSlug(a.linkedinUrl)) return { ok: true, changed: false };
    await ctx.db.patch(c._id, { linkedinUrl: `https://www.linkedin.com/in/${profileSlug(a.linkedinUrl)}` });
    return { ok: true, changed: true };
  },
});
