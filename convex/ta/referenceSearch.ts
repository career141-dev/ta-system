// convex/ta/referenceSearch.ts
//
// Referral Search, the lookup (8 Oct). The model's reading of the sentence
// happens in the web app (src/lib/referralSearch); this takes the criteria it
// produced and finds the people. A query cannot call a model, and the answer
// must be the same every time, so nothing here is generative.
//
// Internal on purpose, like everything under convex/ta: it returns phone numbers
// and emails, and is reachable only with the admin key the TA server holds.

import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { optionalActor } from "./guard";
import { isPlausibleReferee } from "../lib/refereeCheck";
import {
  MAX_TERMS,
  answers,
  groupPeople,
  scoreReferee,
  summaryOf,
  type ReferralCriteria,
  type RefRow,
} from "../lib/referralSearch";

/** Rows read per search phrase. The index returns best matches first; this is how deep we look. */
const PER_TERM = 400;
/** People returned. Past this the search should be narrower, and the page says so. */
const SHOW = 60;
const NAMED_BY = 5;

const criteriaArg = v.object({
  designations: v.array(v.string()),
  companies: v.array(v.string()),
  name: v.union(v.string(), v.null()),
  loose: v.union(v.string(), v.null()),
  needsContact: v.boolean(),
  industry: v.union(v.string(), v.null()),
  summary: v.string(),
});

const rowOf = (r: Doc<"referees">): RefRow => ({
  id: r._id as string,
  candidateId: r.candidateId as string,
  name: r.name,
  designation: r.designation?.trim() || null,
  company: r.company?.trim() || null,
  phone: r.contactNo?.trim() || null,
  email: r.email?.trim() || null,
  relationship: r.relationship?.trim() || null,
  // Older rows have no extractedAt; createdAt is an ISO string.
  at: r.extractedAt ?? (Date.parse(r.createdAt) || 0),
});

async function gather(ctx: QueryCtx, c: ReferralCriteria): Promise<{ rows: RefRow[]; deep: boolean }> {
  const seen = new Map<string, RefRow>();
  let deep = false;
  const take = async (docs: Doc<"referees">[]) => {
    if (docs.length >= PER_TERM) deep = true;
    for (const d of docs) if (!seen.has(d._id as string)) seen.set(d._id as string, rowOf(d));
  };

  // The most selective field first: a company names far fewer rows than a title
  // does, and the other conditions are applied to what comes back (referralSearch.answers).
  if (c.companies.length) {
    for (const term of c.companies.slice(0, MAX_TERMS)) {
      await take(await ctx.db.query("referees").withSearchIndex("search_company", (q) => q.search("company", term)).take(PER_TERM));
    }
  } else if (c.name) {
    await take(await ctx.db.query("referees").withSearchIndex("search_name", (q) => q.search("name", c.name!)).take(PER_TERM));
  } else if (c.designations.length) {
    for (const term of c.designations.slice(0, MAX_TERMS)) {
      await take(await ctx.db.query("referees").withSearchIndex("search_designation", (q) => q.search("designation", term)).take(PER_TERM));
    }
  } else if (c.loose) {
    const w = c.loose;
    await take(await ctx.db.query("referees").withSearchIndex("search_company", (q) => q.search("company", w)).take(PER_TERM));
    await take(await ctx.db.query("referees").withSearchIndex("search_designation", (q) => q.search("designation", w)).take(PER_TERM));
    await take(await ctx.db.query("referees").withSearchIndex("search_name", (q) => q.search("name", w)).take(PER_TERM));
  }
  return { rows: [...seen.values()], deep };
}

export const search = internalQuery({
  args: { actorId: v.optional(v.string()), criteria: criteriaArg },
  handler: async (ctx, args) => {
    await optionalActor(ctx, args.actorId);
    const c = args.criteria as ReferralCriteria;

    const run = async (crit: ReferralCriteria) => {
      const { rows, deep } = await gather(ctx, crit);
      // Rows saved before 30 Sep can hold a CV's duty bullets as "referees".
      const real = rows.filter((r) => isPlausibleReferee({ name: r.name, contactNo: r.phone, email: r.email, company: r.company, designation: r.designation }));
      const hit = real.filter((r) => answers(r, crit)).map((r) => scoreReferee(r, crit));
      return { people: groupPeople(hit), deep };
    };

    let { people, deep } = await run(c);
    // Title and company were both asked for and nobody has both: show who is at
    // the company, and say so, rather than "no results".
    let titleMissed = false;
    if (!people.length && c.designations.length && c.companies.length) {
      const wider = await run({ ...c, designations: [] });
      if (wider.people.length) {
        people = wider.people;
        deep = wider.deep;
        titleMissed = true;
      }
    }

    const total = people.length;
    const shown = people.slice(0, SHOW);

    // Who named each of them, for the people actually shown.
    const names = new Map<string, { id: string; fullName: string; title: string; employer: string } | null>();
    for (const p of shown) {
      for (const id of p.candidateIds.slice(0, NAMED_BY)) {
        if (names.has(id)) continue;
        const cand = await ctx.db.get(id as Doc<"candidates">["_id"]);
        names.set(
          id,
          cand
            ? {
                id,
                fullName: cand.fullName ?? "Unnamed candidate",
                title: cand.currentJobTitle ?? cand.currentTitle ?? "",
                employer: cand.currentEmployer ?? "",
              }
            : null,
        );
      }
    }

    return {
      summary: c.summary || summaryOf(c),
      total,
      /** The index was read to its limit for some phrase: a narrower search would be more complete. */
      deep,
      titleMissed,
      people: shown.map((p) => ({
        id: p.id,
        name: p.name,
        designation: p.designation,
        company: p.company,
        phone: p.phone,
        email: p.email,
        relationship: p.relationship,
        at: p.at,
        why: p.why.slice(0, 3),
        namedByCount: p.candidateIds.length,
        namedBy: p.candidateIds
          .slice(0, NAMED_BY)
          .map((id) => names.get(id))
          .filter((x): x is NonNullable<typeof x> => !!x),
      })),
    };
  },
});
