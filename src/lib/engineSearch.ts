import "server-only";

/**
 * Database search, run by the engine the desk already trusts.
 *
 * `matching/search:aiSearch` is the search that was tuned against real TA
 * feedback over months. It reads the sentence with a model rather than against
 * a vocabulary, embeds it, searches Qdrant with payload filters, runs the
 * backend's full-text indexes in parallel, merges the two, applies the filters
 * with a progressive-narrowing fallback, scores every candidate with
 * `scoreCandidateAgainstRequirements`, and then spends one model call
 * re-ranking only the band where the deterministic score is genuinely
 * uncertain — 50 to 84. Above and below that it does not pay for an opinion it
 * already has.
 *
 * None of that is reimplemented here. This module calls it and translates its
 * answer into the shapes the TA screens already render, so the UI does not
 * change: same box, same chips, same rows.
 *
 * Why not the platform's own matcher for this screen: it was written to filter
 * a database held in memory. Against 77,000 rows the retrieval step is the
 * whole problem, and the engine already solves it — including the part that is
 * hard to get right, which is being good at finding people whose CV does not
 * use the words the recruiter typed.
 */

import type { Candidate, Id, SearchCriteria } from "@/data/types";
import type { Breakdown, Score, ExplainLine, Weights } from "@/lib/scoring";
import { FIT_BANDS } from "@/lib/scoring";
import { convexAction } from "@/lib/convexServer";

export interface EngineHit {
  candidateId: Id;
  score: number;
  reason: string;
  breakdown?: {
    title?: string;
    skills?: string;
    experience?: string;
    location?: string;
    industry?: string;
  };
}

export interface EngineSearch {
  /** How the engine read the sentence — what the chips can show. */
  interpretation: {
    searchText: string;
    industry?: string;
    seniority?: string;
    minYears?: number;
    interpretation: string;
    keywords: string[];
  };
  hits: EngineHit[];
}

/**
 * Ask the engine.
 *
 * ── Which criteria are passed, and why not all of them ──────────────────────
 *
 * Place and years are passed always. They come out of the sentence as literal
 * tokens — "in Colombo", "5+ years" — so the parser reads them exactly, and a
 * recruiter who typed them means them.
 *
 * Titles, skills and industries are passed only when the recruiter SET them.
 * Left to the parser they are a lossy reading of the same sentence the engine
 * is about to read properly: "Campaign Management and Brand Strategy" matched
 * against a vocabulary sample comes back as the single skill "Management",
 * and the engine treats each skill as a term the candidate must carry
 * somewhere. So an accidental word becomes a hard requirement, and a search
 * for two specific skills is narrowed by a third nobody asked for. The engine
 * reads the sentence itself and gets both of them — that reading is better, so
 * it is the one used.
 *
 * Edited chips are different. Removing a chip, or adding one, is a recruiter
 * saying something the sentence did not; the engine must not put it back or
 * ignore it.
 */
export async function engineSearch(
  query: string,
  criteria: SearchCriteria,
  limit = 60,
  /** True when the criteria came from the recruiter editing chips rather than
   *  from parsing the sentence. */
  edited = false,
): Promise<EngineSearch> {
  const res = await convexAction<{
    interpretation: EngineSearch["interpretation"];
    results: EngineHit[];
  }>("matching/search:aiSearch", {
    query,
    location: criteria.locations[0] ?? undefined,
    minExperience: criteria.minExperience ?? undefined,
    maxExperience: criteria.maxExperience ?? undefined,
    industry: edited ? criteria.industries[0] ?? undefined : undefined,
    // Terms every candidate must carry somewhere — skills, certifications,
    // summary or name. That is the desk's own meaning of a skill chip, so a
    // chip the recruiter set maps straight across.
    customFilters: edited && criteria.skills.length ? criteria.skills : undefined,
    limit,
  });
  return { interpretation: res.interpretation, hits: res.results ?? [] };
}

/**
 * The criteria still worth applying after the engine has spoken.
 *
 * The engine enforced place, years and — where the recruiter set them — skills
 * and industry, against its own fields. Enforcing them a second time here
 * against ours does not make the answer stricter, it makes it wrong: the two
 * systems derive a candidate's location from different columns, so a second
 * pass drops people the engine had already confirmed were in the right city,
 * for a disagreement about where the city name is stored rather than about
 * where the person is.
 *
 * What is left is everything the engine has no notion of, because it was never
 * a database search tool: notice period, salary expectation, availability,
 * nationality, language. Those are the desk's rules about who may be
 * approached, and they still hold.
 */
export function deskCriteria(criteria: SearchCriteria): SearchCriteria {
  return {
    ...criteria,
    locations: [],
    minExperience: null,
    maxExperience: null,
    /*
     * The words go too, and this is the part that is easy to get wrong.
     *
     * The filter path keeps a deliberate escape hatch: when a query has words
     * in it, a candidate who MATCHES THOSE WORDS is admitted even if their
     * similarity fell under the bar, so a CV reading "Procurement Manager" is
     * never hidden from a search for one because its vector landed badly.
     *
     * That hatch is right for a search by meaning and wrong here. The working
     * set is not the database — it is whoever this request happened to load,
     * which includes the 742 people the alert badge primed — so leaving the
     * words in admits anyone in that arbitrary set who matches them, with no
     * engine score at all. It showed as 399 results for a search the engine
     * answered with 18, the extra 381 being follow-up candidates who merely
     * had "Management" somewhere, sorted to the bottom on a score of zero.
     */
    titles: [],
    skills: [],
    industries: [],
    employers: [],
    qualifications: [],
  };
}

// ─── the engine's answer, in the shapes the screens render ───────────────────

/**
 * The engine reports each dimension in words — "strong match", "below range" —
 * rather than as a number, because that is what it shows its own users.
 *
 * `FitPanel` draws bars, so the words need a height. These are the midpoints of
 * the bands the engine's own thresholds describe, and the explanation lines
 * below carry the original wording so nobody reads a bar as a precise score
 * that was never computed.
 */
const BAND_HEIGHT: Record<string, number> = {
  "strong match": 90,
  match: 90,
  "meets target": 90,
  "partial match": 65,
  region_match: 65,
  "loose match": 35,
  "below range": 35,
  different: 20,
  "not specified": 0,
};

const heightOf = (word: string | undefined): number =>
  word ? BAND_HEIGHT[word.toLowerCase()] ?? 0 : 0;

/** Even weights: the engine's own weighting is internal and per-job, so
 *  presenting a made-up split as if it were the engine's would be worse than
 *  presenting none. The bars show the dimensions, not their importance. */
const EVEN: Weights = { title: 0.2, skills: 0.2, seniority: 0.2, experience: 0.2, industry: 0.2 };

export function scoreFromEngine(hit: EngineHit): Score {
  const b = hit.breakdown ?? {};
  const breakdown: Breakdown = {
    title: heightOf(b.title),
    skills: heightOf(b.skills),
    // The engine reports location and experience; it has no separate seniority
    // line on this screen, so that bar is left at zero rather than invented.
    seniority: 0,
    experience: heightOf(b.experience),
    industry: heightOf(b.industry),
  };

  const explanation: ExplainLine[] = [];
  const line = (part: ExplainLine["part"], word: string | undefined, detail: string) => {
    if (!word) return;
    explanation.push({ part, score: heightOf(word), weight: null, points: 0, detail });
  };
  line("Title", b.title, `Title: ${b.title}.`);
  line("Skills", b.skills, `Skills: ${b.skills}.`);
  line("Experience", b.experience, `Experience: ${b.experience}.`);
  line("Industry", b.industry, `Industry: ${b.industry}.`);
  if (b.location) {
    explanation.push({
      part: "Penalty",
      score: null,
      weight: null,
      points: 0,
      detail: `Location: ${b.location}.`,
    });
  }

  return {
    overall: Math.round(hit.score),
    band: hit.score >= FIT_BANDS.strong ? "strong" : hit.score >= FIT_BANDS.worth ? "worth a look" : "weak",
    breakdown,
    weights: EVEN,
    // The engine's own sentence, which is the thing a TA actually reads.
    reasons: [hit.reason].filter(Boolean),
    matchedSkills: [],
    missingSkills: [],
    penalties: [],
    semanticUsed: true,
    explanation,
  };
}

/** What the result row shows as met and missed, read off the engine's words. */
export function hitsAndMisses(
  hit: EngineHit,
  candidate: Candidate,
  criteria: SearchCriteria,
  /** As in `engineSearch`: true when the criteria are the recruiter's, not the
   *  parser's reading of the sentence. */
  edited = false,
): { hits: string[]; misses: string[] } {
  const hits: string[] = [];
  const misses: string[] = [];
  const b = hit.breakdown ?? {};

  if (b.title && b.title !== "loose match" && candidate.currentTitle) hits.push(candidate.currentTitle);
  /*
   * The place ASKED FOR, not the place on file.
   *
   * A chip saying "Colombo" answers the question the recruiter asked. The
   * record's own field is a postal line — "No. 50/5, Anula road, Colombo 06,
   * Sri Lanka." — and putting that on a chip beside the skills reads as
   * noise, not as confirmation.
   */
  const asked = criteria.locations[0] ?? null;
  if (b.location === "match") hits.push(asked ?? candidate.location ?? "");
  if (b.location === "different" && criteria.locations.length) misses.push(criteria.locations.join(" / "));

  /*
   * Skill chips only where the recruiter set them.
   *
   * Left to the parser, `criteria.skills` is a vocabulary match over the
   * sentence, and a vocabulary match over "Campaign Management and Brand
   * Strategy" returns the single word "Management". A chip reading "missing:
   * Management" against a Brand Manager at Dialog Axiata is not a finding — it
   * is the parser's mistake presented as a fact about the person. The engine
   * names the real gaps in its own sentence, which the row already shows.
   */
  if (edited) {
    const have = candidate.skills.map((s) => s.toLowerCase());
    for (const want of criteria.skills) {
      const w = want.toLowerCase();
      if (have.some((h) => h.includes(w) || w.includes(h))) hits.push(want);
      else misses.push(want);
    }
  }
  if (b.experience === "below range" && criteria.minExperience != null) {
    misses.push(`${criteria.minExperience}+ years`);
  }
  return { hits: [...new Set(hits.filter(Boolean))], misses: [...new Set(misses)] };
}
