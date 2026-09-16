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
 * None of that is reimplemented here. This module runs the engine's own
 * functions — see "the engine, run here" below for why not the action itself —
 * and translates its answer into the shapes the TA screens already render, so
 * the UI does not change: same box, same chips, same rows.
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
import type { LiveCandidate } from "@/data/convex/map";
import * as backend from "@/data/convex/backend";
import { embedQuery } from "@/lib/embed";
import { searchVectors } from "@/lib/qdrantSearch";
import { maxModelCost, modelCost, reserve } from "@/lib/spend";

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
export function engineSearch(
  query: string,
  criteria: SearchCriteria,
  limit = 60,
  /** True when the criteria came from the recruiter editing chips rather than
   *  from parsing the sentence. */
  edited = false,
): Promise<EngineSearch> {
  const args = engineArgs(query, criteria, limit, edited);

  /*
   * The same search, answered once.
   *
   * A run is a model reading the sentence, a vector search, the full-text
   * indexes, scoring, and a second model call re-ranking the uncertain band.
   * The results page asked for it again on page 2, on the way back from a
   * profile, and on every reload, for an identical answer. So an answer is kept
   * for a few minutes against exactly what was sent, and a request that arrives
   * while the same search is running waits for that run instead of starting a
   * second one.
   *
   * Short-lived on purpose: a CV that arrives is in the next search after the
   * window, and a changed chip is a different key, so it runs fresh.
   */
  const key = JSON.stringify(args);
  const now = Date.now();
  const held = engineCache.get(key);
  if (held && now - held.at < ENGINE_CACHE_MS) {
    // Touched, so the least recently used is what goes when the cache is full.
    engineCache.delete(key);
    engineCache.set(key, held);
    return held.value;
  }

  const entry: CacheEntry = { at: now, value: runEngine(args, true), done: null };
  entry.value.then((r) => (entry.done = r)).catch(() => {
    // A failed run is not an answer to keep: the next request tries again.
    if (engineCache.get(key) === entry) engineCache.delete(key);
  });
  engineCache.set(key, entry);
  while (engineCache.size > ENGINE_CACHE_MAX) engineCache.delete(engineCache.keys().next().value!);
  return entry.value;
}

/**
 * The finished answer to exactly this search, if one is held — without waiting.
 * What lets a page that already has it skip the quick pass entirely.
 */
export function cachedEngineSearch(query: string, criteria: SearchCriteria, limit = 60, edited = false): EngineSearch | null {
  const held = engineCache.get(JSON.stringify(engineArgs(query, criteria, limit, edited)));
  return held && Date.now() - held.at < ENGINE_CACHE_MS ? held.done : null;
}

/**
 * The same search with no model: the sentence goes straight to retrieval, and
 * the engine's deterministic score ranks what comes back, against requirements
 * read from the chips. About a second, where the full run is ten or more — so
 * the page shows this first and replaces it when `engineSearch` answers.
 */
export function quickEngineSearch(query: string, criteria: SearchCriteria, limit = 60, edited = false): Promise<EngineSearch> {
  return runEngine(engineArgs(query, criteria, limit, edited), false);
}

const ENGINE_CACHE_MS = 5 * 60_000;
const ENGINE_CACHE_MAX = 50;
type CacheEntry = { at: number; value: Promise<EngineSearch>; done: EngineSearch | null };
const engineCache = new Map<string, CacheEntry>();

// ─── the engine, run here ────────────────────────────────────────────────────

/*
 * `matching/search:aiSearch`, step for step, from this server.
 *
 * Calling the action was measured on 16 September at 39 s for one search, with
 * nothing on screen until all of it was done. The time is almost all two model
 * calls — reading the sentence (4–10 s) and re-ranking the uncertain band
 * (4–17 s) — run one after the other behind the embedding and the searches.
 * Here the searches start while the model is still reading, and the page gets
 * a deterministic ranking to show in the meantime.
 *
 * Not a reimplementation: the reading, scoring and re-ranking are the engine's
 * own functions (convex/lib/jdParser, convex/cvs/cvScoring), imported, so a
 * correction to the engine is a correction here. What is repeated is the
 * orchestration and the filter step, which live inside the action and cannot
 * be imported; they follow the action's rules (convex/matching/search.ts).
 */

type EngineArgs = ReturnType<typeof engineArgs>;

function engineArgs(query: string, criteria: SearchCriteria, limit: number, edited: boolean) {
  return {
    query: query.trim().replace(/\s+/g, " "),
    location: criteria.locations[0] ?? undefined,
    minExperience: criteria.minExperience ?? undefined,
    maxExperience: criteria.maxExperience ?? undefined,
    industry: edited ? criteria.industries[0] ?? undefined : undefined,
    // Terms every candidate must carry somewhere — skills, certifications,
    // summary or name. That is the desk's own meaning of a skill chip, so a
    // chip the recruiter set maps straight across.
    customFilters: edited && criteria.skills.length ? criteria.skills : undefined,
    limit,
    /** Read by the quick pass only; not part of what the engine is asked. */
    chips: { titles: criteria.titles, skills: criteria.skills, industries: criteria.industries },
  };
}

const NO_ACTOR = { id: null as string | null };
const MODEL = "deepseek/deepseek-v4-flash";
const FETCH_LIMIT = 100;
const POOL_CAP = 200;
const RERANK_BATCH = 10;

const modules = () =>
  Promise.all([import("../../convex/lib/jdParser"), import("../../convex/cvs/cvScoring")]).then(([parser, scoring]) => ({
    parser,
    scoring,
  }));

type Requirements = import("../../convex/lib/jdParser").SearchRequirements;
type Scored = import("../../convex/cvs/cvScoring").ScoredCandidate;
type Doc = LiveCandidate & { vectorScore: number };

/** The model's reading of a sentence depends on nothing else, so it is shared across chips. */
const intents = new Map<string, { at: number; value: ReturnType<typeof readSentence> }>();

function readSentence(parser: Awaited<ReturnType<typeof modules>>["parser"], text: string) {
  const settle = reserve("database search: read the query", maxModelCost(MODEL, 6000 + text.length, 1400));
  const run = parser.extractSearchRequirements(text, "natural_language");
  run.then(
    (r) => settle(modelCost(MODEL, r.usage.promptTokens, r.usage.completionTokens)),
    () => settle(0),
  );
  return run;
}

function intentFor(parser: Awaited<ReturnType<typeof modules>>["parser"], text: string) {
  const key = text.toLowerCase();
  const held = intents.get(key);
  if (held && Date.now() - held.at < ENGINE_CACHE_MS) return held.value;
  const value = readSentence(parser, text);
  intents.set(key, { at: Date.now(), value });
  value.catch(() => intents.delete(key));
  while (intents.size > ENGINE_CACHE_MAX) intents.delete(intents.keys().next().value!);
  return value;
}

async function runEngine(args: EngineArgs, withModel: boolean): Promise<EngineSearch> {
  const { parser, scoring } = await modules();
  const q = args.query;

  // 1 and 2 overlap: the words and the vectors are searched on the sentence
  // itself while the model reads it.
  const intent = withModel ? intentFor(parser, q) : null;
  const firstPass = Promise.all([
    vectorPool(q, args),
    backend.keywordSearchMany(NO_ACTOR, [q, ...args.chips.titles, ...args.chips.skills.slice(0, 3)], FETCH_LIMIT).catch(() => []),
  ]);

  const parsed = intent ? (await intent).requirements : requirementsFromChips(args);
  const req: Requirements = {
    ...parsed,
    industry: args.industry ?? parsed.industry,
    location: args.location ?? parsed.location,
    minYearsExperience: args.minExperience && args.minExperience > 0 ? args.minExperience : parsed.minYearsExperience ?? null,
  };

  // The engine's own search terms, as the action picks them: title, alternative
  // titles, required skills, then its term builder — the first three.
  let secondPass: Promise<{ candidateId: Id }[]> = Promise.resolve([]);
  if (intent) {
    const terms = new Set<string>();
    terms.add(req.title && req.title.length > 2 ? req.title : q);
    for (const t of req.alternativeTitles.slice(0, 3)) if (t) terms.add(t);
    for (const t of req.requiredSkills.slice(0, 4)) if (t) terms.add(t);
    for (const t of parser.buildSearchTerms(req, q).slice(0, 4)) if (t) terms.add(t);
    secondPass = backend.keywordSearchMany(NO_ACTOR, [...terms].slice(0, 3), FETCH_LIMIT).catch(() => []);
  }
  const [[vectors, words], more] = await Promise.all([firstPass, secondPass]);

  // 3. Fusion: vector hits first, then words, no one twice.
  const vectorScore = new Map<Id, number>();
  for (const v of vectors) if (!vectorScore.has(v.candidateId)) vectorScore.set(v.candidateId, v.score);
  const ids = [...new Set([...vectorScore.keys(), ...words.map((w) => w.candidateId), ...more.map((w) => w.candidateId)])].slice(0, POOL_CAP);

  const docs = await backend.candidateDocsByIds(NO_ACTOR, ids);
  const byId = new Map(docs.map((d) => [d._id, d]));
  const pool: Doc[] = ids.flatMap((id) => {
    const d = byId.get(id);
    return d ? [{ ...d, vectorScore: vectorScore.get(id) ?? 0 }] : [];
  });
  if (pool.length === 0) {
    return { interpretation: interpretationOf(req, intent !== null), hits: [] };
  }

  // The action's strict filters, with its progressive fallback: if they leave
  // nobody, score everyone rather than show nothing.
  const filtered = strictFilters(pool, args);
  const candidates = filtered.length > 0 ? filtered : pool;

  // 4. The engine's weighted score.
  const ranked = candidates
    .map((doc, i) => scoring.scoreCandidateAgainstRequirements(doc as never, req, i))
    .sort((a, b) => b.overallScore - a.overallScore || b.titleScore - a.titleScore || b.skillScore - a.skillScore || b.experienceScore - a.experienceScore);

  // 5. The model reads only the band the score is unsure about.
  const verdicts = new Map<number, { score: number; reason: string }>();
  if (withModel) {
    const ambiguous = ranked.filter((c) => c.overallScore >= 50 && c.overallScore < 85).slice(0, RERANK_BATCH);
    if (ambiguous.length > 0) {
      const settle = reserve("database search: re-rank", maxModelCost(MODEL, 6000, 4000));
      try {
        const { evaluations, usage } = await scoring.scoreBatchWithLLM(ambiguous, req, "search_ranking");
        settle(modelCost(MODEL, usage.promptTokens ?? 0, usage.completionTokens ?? 0));
        for (const [index, v] of evaluations) verdicts.set(index, v);
      } catch {
        // As the action does: the deterministic score stands.
        settle(0);
      }
    }
  }

  const final = ranked
    .map((c) => ({ c, score: verdicts.get(c.index)?.score ?? c.overallScore, reason: verdicts.get(c.index)?.reason ?? scoring.buildDeterministicTaReason(c, req) }))
    .sort((a, b) => b.score - a.score || (b.c.cv.vectorScore ?? 0) - (a.c.cv.vectorScore ?? 0) || b.c.overallScore - a.c.overallScore);

  return {
    interpretation: interpretationOf(req, intent !== null),
    hits: final
      .filter((f) => f.score > 0)
      .slice(0, args.limit)
      .map((f) => ({ candidateId: f.c.cv._id, score: Math.round(f.score), reason: f.reason, breakdown: breakdownOf(f.c, req) })),
  };
}

/** Meaning: the query embedded the same way the index was, the nearest 200. */
async function vectorPool(q: string, args: EngineArgs): Promise<{ candidateId: Id; score: number }[]> {
  try {
    const e = await embedQuery(q);
    if (!e.ok) return [];
    const hits = await searchVectors(e.vectors[0], 200, { minExperience: args.minExperience ?? null });
    // As the action does: a filtered search that finds nobody usually means the
    // index lacks the field, so ask by meaning alone.
    return hits.length > 0 || !args.minExperience ? hits : await searchVectors(e.vectors[0], 200);
  } catch {
    // Either route can be down without the other stopping.
    return [];
  }
}

/** The action's `applyFiltersStrictly`, for the arguments this screen sends. */
function strictFilters(list: Doc[], args: EngineArgs): Doc[] {
  let out = list;
  if (args.location) {
    const want = args.location.toLowerCase().trim();
    out = out.filter((c) => {
      const at = (c.location || "").toLowerCase();
      if (want === "remote") return ["remote", "wfh", "home", "work from home"].some((w) => at.includes(w));
      return at.includes(want);
    });
  }
  const years = (c: Doc) => c.totalExperienceYears ?? (c as { yearsOfExperience?: number }).yearsOfExperience;
  if (args.minExperience !== undefined && args.minExperience > 0) {
    out = out.filter((c) => years(c) == null || years(c)! >= args.minExperience!);
  }
  if (args.maxExperience !== undefined && args.maxExperience < 20) {
    out = out.filter((c) => years(c) == null || years(c)! <= args.maxExperience!);
  }
  if (args.customFilters?.length) {
    out = out.filter((c) => {
      const skills = ((c.skills ?? []) as unknown[]).map((s) => (typeof s === "string" ? s : String((s as { value?: string }).value ?? "")).toLowerCase());
      const certs = ((c.certifications ?? []) as string[]).map((x) => x.toLowerCase());
      const summary = String((c as { summary?: string }).summary ?? "").toLowerCase();
      const name = String(c.fullName ?? "").toLowerCase();
      return args.customFilters!.every((f) => {
        const t = f.toLowerCase().trim();
        return !t || skills.some((s) => s.includes(t)) || certs.some((x) => x.includes(t)) || summary.includes(t) || name.includes(t);
      });
    });
  }
  return out;
}

function breakdownOf(c: Scored, req: Requirements): EngineHit["breakdown"] {
  const cv = c.cv as Scored["cv"] & { totalExperienceYears?: number };
  const years = cv.yearsOfExperience ?? cv.totalExperienceYears ?? 0;
  return {
    title: c.titleScore >= 90 ? "strong match" : c.titleScore >= 70 ? "partial match" : "loose match",
    skills: c.skillScore >= 80 ? "strong match" : c.skillScore >= 50 ? "partial match" : "loose match",
    experience: req.minYearsExperience != null ? (years >= req.minYearsExperience ? "meets target" : "below range") : "not specified",
    location: c.locationStatus === "match" ? "match" : c.locationStatus === "different" ? "different" : "not specified",
    industry: c.industryScore === 100 ? "match" : "different",
  };
}

function interpretationOf(req: Requirements, read: boolean): EngineSearch["interpretation"] {
  return {
    searchText: [req.title, ...req.alternativeTitles, ...req.requiredSkills.slice(0, 4)].filter(Boolean).join(" "),
    industry: req.industry ?? undefined,
    seniority: req.seniority ?? undefined,
    minYears: req.minYearsExperience ?? undefined,
    // Empty until a model has read the sentence: the chips are not a reading of it.
    interpretation: read ? req.summary : "",
    keywords: read ? req.keywords : [],
  };
}

/** The chips, in the engine's shape — what the quick pass ranks against. */
function requirementsFromChips(args: EngineArgs): Requirements {
  return {
    title: args.chips.titles[0] ?? args.query,
    alternativeTitles: args.chips.titles.slice(1),
    occupationSynonyms: [],
    requiredSkills: args.chips.skills,
    preferredSkills: [],
    minYearsExperience: args.minExperience ?? null,
    maxYearsExperience: args.maxExperience ?? null,
    industry: args.chips.industries[0] ?? null,
    seniority: null,
    location: args.location ?? null,
    education: null,
    summary: args.query,
    keywords: [],
    languages: [],
    clientCompany: null,
    clientContactEmail: null,
    salaryRange: null,
  };
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
