import "server-only";

/**
 * Hybrid AI search — the backend's `matching/search:aiSearch`, run from here.
 *
 *   1. Intent       the sentence read by a model into title, synonyms, skills,
 *                   years, seniority, place (convex/lib/jdParser)
 *   2. Retrieval    in parallel: meaning (embedding → Qdrant, top 200) and
 *                   words (Convex full-text over title, skills, summary, CV)
 *   3. Fusion       merged and de-duplicated, vector hits first
 *   4. Scoring      the engine's weighted title / skills / experience /
 *                   location / industry score (convex/cvs/cvScoring)
 *   5. Re-ranking   the ambiguous band (50–84) sent to a model, in one batch of
 *                   at most 10, for a calibrated score and a TA-readable reason
 *
 * The same functions as the backend action, imported rather than copied, so
 * the two cannot drift. Why not call the action: measured 16 September it took
 * 39 s for one search, and nothing on screen until all of it was done. Run
 * here the steps overlap, and the page can show step 4's ranking in about a
 * second and stream step 5 in behind it (see `quickSearch`).
 *
 * One thing is the desk's, not the engine's: the strict filters — years,
 * notice, salary, availability (lib/match) and place — decide who is in the
 * result at all, and only people who pass them are sent to the model. Place is
 * matched the engine's way, as "contains": "Colombo" finds "Colombo, Sri
 * Lanka", which the desk's exact match did not. Everybody scored is returned
 * with `passes` set, so the page can still say which filter emptied a search.
 */

import type { Candidate, Id, SearchCriteria } from "@/data/types";
import type { LiveCandidate } from "@/data/convex/map";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import * as backend from "@/data/convex/backend";
import { matchCandidate } from "./match";
import { embedQuery } from "./embed";
import { searchVectors } from "./qdrantSearch";
import { maxModelCost, modelCost, reserve } from "./spend";
import type { SearchRequirements } from "../../convex/lib/jdParser";
import type { ScoredCandidate } from "../../convex/cvs/cvScoring";

const NO_ACTOR = { id: null as string | null };
const MODEL = "deepseek/deepseek-v4-flash";
const VECTOR_LIMIT = 200;
const KEYWORD_LIMIT_EACH = 100;
const POOL_CAP = 200;
const RERANK_BATCH = 10;

export type Match = "strong match" | "partial match" | "loose match";

export interface AiHit {
  candidateId: Id;
  /** Passes the strict filters it was searched with. */
  passes: boolean;
  /** 0–100: the model's where it re-ranked, the engine's heuristic otherwise. */
  score: number;
  reason: string;
  /** True when a model read this candidate; false for the heuristic alone. */
  reranked: boolean;
  breakdown: { title: Match; skills: Match; experience: string; location: string; industry: string };
}

export interface AiSearchResult {
  phase: "quick" | "full";
  /** How the query was read, in a sentence. Null before the model has read it. */
  interpretation: string | null;
  /** Everybody scored, best first. Filter on `passes` — or on `passesStrict` with other criteria. */
  hits: AiHit[];
  /** Things that did not run, said plainly — never silently empty. */
  problems: string[];
  timings: Record<string, number>;
}

// ─── Engine modules, loaded once ─────────────────────────────────────────────

const engine = () =>
  Promise.all([import("../../convex/lib/jdParser"), import("../../convex/cvs/cvScoring")]).then(([parser, scoring]) => ({
    parser,
    scoring,
  }));

// ─── Caches ──────────────────────────────────────────────────────────────────

const TTL = 10 * 60_000;
const MAX_ENTRIES = 100;

function lru<V>() {
  const map = new Map<string, { at: number; value: V }>();
  return {
    get(key: string): V | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > TTL) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V) {
      map.set(key, { at: Date.now(), value });
      if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
    },
    delete: (key: string) => map.delete(key),
  };
}

const normalise = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");
/** The model's reading of a sentence does not depend on the filters, so it is shared across them. */
const intents = lru<Promise<{ requirements: SearchRequirements; usage: { promptTokens: number; completionTokens: number; model: string } }>>();
const finished = lru<AiSearchResult>();
const running = new Map<string, Promise<AiSearchResult>>();

/** Words cleared: in this route they rank, through the engine, and only the rest filters. */
export function strictOnly(c: SearchCriteria): SearchCriteria {
  return { ...c, titles: [], skills: [], industries: [], employers: [], qualifications: [] };
}

/**
 * The strict filters, as this route applies them: the desk's rules for
 * everything but place, and place as "contains" rather than equals. Returns the
 * desk's match (hits, misses, signals) for the row, or null.
 */
export function passesStrict(c: Candidate, criteria: SearchCriteria) {
  const r = matchCandidate(c, { ...strictOnly(criteria), locations: [] }, repo.applicationsForCandidate(c.id));
  if (!r) return null;
  if (criteria.locations.length) {
    const where = (c.location ?? "").toLowerCase();
    const place = criteria.locations.find((l) => where.includes(l.toLowerCase()));
    if (!place) return null;
    r.hits.push(c.location!);
  }
  return r;
}

const keyOf = (q: string, c: SearchCriteria) => `${normalise(q)}|${JSON.stringify(strictOnly(c))}`;

/** The finished, re-ranked result, if this exact search ran in the last ten minutes. */
export function cachedAiSearch(q: string, criteria: SearchCriteria): AiSearchResult | null {
  return finished.get(keyOf(q, criteria)) ?? null;
}

// ─── The two phases ──────────────────────────────────────────────────────────

/**
 * Steps 2–4 with no model: requirements from the desk's own parser, retrieval
 * on the sentence and on those words, the engine's heuristic score. About a
 * second; what the page shows while `aiSearch` finishes.
 */
export async function quickSearch(q: string, criteria: SearchCriteria): Promise<AiSearchResult> {
  const timings: Record<string, number> = {};
  const problems: string[] = [];
  const req = requirementsFromCriteria(q, criteria);
  const terms = [q, ...criteria.titles, ...criteria.skills.slice(0, 3)];
  const pool = await retrieve(q, terms, criteria, timings, problems);
  const { scoring } = await engine();
  const kept = await fetchPool(pool, timings);
  const passing = passingIds(kept, criteria);
  const ranked = time(timings, "score", () => rank(scoring, kept, req));
  return {
    phase: "quick",
    interpretation: null,
    hits: ranked.map((s) => toHit(s, req, scoring.buildDeterministicTaReason(s, req), false, passing.has(s.cv._id))),
    problems,
    timings,
  };
}

/** All five steps. Cached for ten minutes, and a second caller joins the first run. */
export function aiSearch(q: string, criteria: SearchCriteria): Promise<AiSearchResult> {
  const key = keyOf(q, criteria);
  const done = finished.get(key);
  if (done) return Promise.resolve(done);
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  const run = fullSearch(q, criteria)
    .then((r) => {
      finished.set(key, r);
      return r;
    })
    .finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

async function fullSearch(q: string, criteria: SearchCriteria): Promise<AiSearchResult> {
  const timings: Record<string, number> = {};
  const problems: string[] = [];
  const { parser, scoring } = await engine();

  // 1 and 2 overlap: retrieval on the sentence itself starts while the model
  // is still reading it, and the model's titles and skills add a second pass.
  const intentRun = timeAsync(timings, "intent (model)", () => readIntent(parser, q));
  const firstPass = retrieve(q, [q, ...criteria.titles, ...criteria.skills.slice(0, 3)], criteria, timings, problems);

  let req: SearchRequirements;
  try {
    const parsed = await intentRun;
    req = {
      ...parsed.requirements,
      // The desk's chips win where they are set: they are what the TA can see and edit.
      minYearsExperience: criteria.minExperience ?? parsed.requirements.minYearsExperience,
      location: criteria.locations[0] ?? parsed.requirements.location,
    };
  } catch (e) {
    problems.push(`The AI could not read the query (${(e as Error).message}), so it is ranked on the words it contains.`);
    req = requirementsFromCriteria(q, criteria);
  }

  const engineTerms = new Set<string>();
  const primary = req.title && req.title.length > 2 && req.title !== "Position" ? req.title : q;
  engineTerms.add(primary);
  for (const t of req.alternativeTitles.slice(0, 3)) engineTerms.add(t);
  for (const t of req.requiredSkills.slice(0, 4)) engineTerms.add(t);
  for (const t of parser.buildSearchTerms(req, q).slice(0, 4)) engineTerms.add(t);
  const [first, second] = await Promise.all([
    firstPass,
    timeAsync(timings, "keywords (AI terms)", () =>
      backend.keywordSearchMany(NO_ACTOR, [...engineTerms].slice(0, 3), KEYWORD_LIMIT_EACH).catch(() => []),
    ),
  ]);
  const pool = fuse(first, second.map((h) => h.candidateId));

  const kept = await fetchPool(pool, timings);
  const passing = passingIds(kept, criteria);
  const ranked = time(timings, "score", () => rank(scoring, kept, req));

  // 5. The deterministic gate: sure answers skip the model, the ambiguous band
  // does not — and nobody the strict filters removed is paid for.
  const ambiguous = ranked
    .filter((s) => passing.has(s.cv._id) && s.overallScore >= 50 && s.overallScore < 85)
    .slice(0, RERANK_BATCH);
  const verdicts = new Map<number, { score: number; reason: string }>();
  if (ambiguous.length > 0) {
    try {
      const settle = reserve("AI search re-rank", maxModelCost(MODEL, 6000, 4000));
      const { evaluations, usage } = await timeAsync(timings, `re-rank ${ambiguous.length} (model)`, () =>
        scoring.scoreBatchWithLLM(ambiguous, req, "search_ranking"),
      );
      settle(modelCost(MODEL, usage.promptTokens ?? 0, usage.completionTokens ?? 0));
      for (const [index, v] of evaluations) verdicts.set(index, v);
    } catch (e) {
      problems.push(`The AI re-ranking did not run (${(e as Error).message}); these are the engine's own scores.`);
    }
  }

  const hits = ranked.map((s) => {
    const v = verdicts.get(s.index);
    const passes = passing.has(s.cv._id);
    return v
      ? toHit(s, req, v.reason, true, passes, v.score)
      : toHit(s, req, scoring.buildDeterministicTaReason(s, req), false, passes);
  });
  const vectorOf = new Map(ranked.map((s) => [s.cv._id, s.cv.vectorScore ?? 0]));
  const overallOf = new Map(ranked.map((s) => [s.cv._id, s.overallScore]));
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (vectorOf.get(b.candidateId) ?? 0) - (vectorOf.get(a.candidateId) ?? 0) ||
      (overallOf.get(b.candidateId) ?? 0) - (overallOf.get(a.candidateId) ?? 0),
  );

  return {
    phase: "full",
    interpretation: req.summary || null,
    hits: hits.filter((h) => h.score > 0),
    problems,
    timings,
  };
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Pool = { candidateId: Id; vectorScore: number }[];

function readIntent(parser: Awaited<ReturnType<typeof engine>>["parser"], q: string) {
  const key = normalise(q);
  let run = intents.get(key);
  if (!run) {
    const settle = reserve("AI search intent", maxModelCost(MODEL, 6000 + q.length, 1400));
    run = parser.extractSearchRequirements(q, "natural_language");
    run.then(
      (r) => settle(modelCost(MODEL, r.usage.promptTokens, r.usage.completionTokens)),
      () => {
        settle(0);
        intents.delete(key);
      },
    );
    intents.set(key, run);
  }
  return run;
}

/** Meaning and words, together. Either failing leaves the other standing. */
async function retrieve(
  q: string,
  terms: string[],
  criteria: SearchCriteria,
  timings: Record<string, number>,
  problems: string[],
): Promise<Pool> {
  const vectors = timeAsync(timings, "vectors (embed + Qdrant)", async () => {
    const e = await embedQuery(q);
    if (!e.ok) throw new Error(e.reason);
    return searchVectors(e.vectors[0], VECTOR_LIMIT, { minExperience: criteria.minExperience });
  }).catch((e) => {
    problems.push(`Search by meaning did not run (${(e as Error).message}); these were found on the words.`);
    return [];
  });
  const words = timeAsync(timings, "keywords", () => backend.keywordSearchMany(NO_ACTOR, terms, KEYWORD_LIMIT_EACH)).catch((e) => {
    problems.push(`The keyword index could not be searched (${(e as Error).message}).`);
    return [];
  });
  const [v, w] = await Promise.all([vectors, words]);
  const pool: Pool = v.map((h) => ({ candidateId: h.candidateId, vectorScore: h.score }));
  return fuse(pool, w.map((h) => h.candidateId));
}

function fuse(pool: Pool, keywordIds: Id[]): Pool {
  const seen = new Set(pool.map((p) => p.candidateId));
  const out = [...pool];
  for (const id of keywordIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ candidateId: id, vectorScore: 0 });
  }
  return out.slice(0, POOL_CAP);
}

type Fetched = { doc: LiveCandidate & { vectorScore: number }; candidate: Candidate };

/** The pool's rows: the engine's shape to score, the platform's to filter and show. */
async function fetchPool(pool: Pool, timings: Record<string, number>): Promise<Fetched[]> {
  const ids = pool.map((p) => p.candidateId);
  const [docs] = await timeAsync(timings, `fetch ${ids.length}`, () =>
    Promise.all([backend.candidateDocsByIds(NO_ACTOR, ids), primeStore({ candidateIds: ids })]),
  );
  const byId = new Map(docs.map((d) => [d._id, d]));
  const out: Fetched[] = [];
  for (const p of pool) {
    const doc = byId.get(p.candidateId);
    const candidate = repo.candidate(p.candidateId);
    if (doc && candidate) out.push({ doc: { ...doc, vectorScore: p.vectorScore }, candidate });
  }
  return out;
}

const passingIds = (kept: Fetched[], criteria: SearchCriteria) =>
  new Set(kept.filter((k) => passesStrict(k.candidate, criteria)).map((k) => k.candidate.id));

function rank(
  scoring: Awaited<ReturnType<typeof engine>>["scoring"],
  kept: Fetched[],
  req: SearchRequirements,
): ScoredCandidate[] {
  return kept
    .map((k, i) => scoring.scoreCandidateAgainstRequirements(k.doc as never, req, i))
    .sort(
      (a, b) =>
        b.overallScore - a.overallScore ||
        b.titleScore - a.titleScore ||
        b.skillScore - a.skillScore ||
        (b.cv.vectorScore ?? 0) - (a.cv.vectorScore ?? 0),
    );
}

function toHit(
  s: ScoredCandidate,
  req: SearchRequirements,
  reason: string,
  reranked: boolean,
  passes: boolean,
  score = s.overallScore,
): AiHit {
  const band = (n: number, strong: number, partial: number): Match =>
    n >= strong ? "strong match" : n >= partial ? "partial match" : "loose match";
  const cv = s.cv as ScoredCandidate["cv"] & { totalExperienceYears?: number };
  const years = cv.yearsOfExperience ?? cv.totalExperienceYears ?? 0;
  return {
    candidateId: s.cv._id,
    passes,
    score: Math.round(score),
    reason,
    reranked,
    breakdown: {
      title: band(s.titleScore, 90, 70),
      skills: band(s.skillScore, 80, 50),
      experience: req.minYearsExperience != null ? (years >= req.minYearsExperience ? "meets target" : "below range") : "not specified",
      location: s.locationStatus === "match" ? "match" : s.locationStatus === "different" ? "different" : "not specified",
      industry: s.industryScore === 100 ? "match" : "different",
    },
  };
}

/** The desk's parser, in the engine's shape — for the quick phase and when the model is down. */
function requirementsFromCriteria(q: string, c: SearchCriteria): SearchRequirements {
  return {
    title: c.titles[0] ?? q,
    alternativeTitles: c.titles.slice(1),
    occupationSynonyms: [],
    requiredSkills: c.skills,
    preferredSkills: [],
    minYearsExperience: c.minExperience,
    maxYearsExperience: c.maxExperience,
    industry: c.industries[0] ?? null,
    seniority: null,
    location: c.locations[0] ?? null,
    education: c.qualifications[0] ?? null,
    summary: q,
    keywords: c.employers,
    languages: c.languages,
    clientCompany: null,
    clientContactEmail: null,
    salaryRange: null,
  };
}

function time<T>(timings: Record<string, number>, label: string, fn: () => T): T {
  const s = performance.now();
  try {
    return fn();
  } finally {
    timings[label] = Math.round(performance.now() - s);
  }
}

async function timeAsync<T>(timings: Record<string, number>, label: string, fn: () => Promise<T>): Promise<T> {
  const s = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = Math.round(performance.now() - s);
  }
}
