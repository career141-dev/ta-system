import "server-only";

/**
 * Database search, run by the engine the desk already trusts.
 *
 * `matching/search:aiSearch` is the search that was tuned against real TA
 * feedback over months. It reads the sentence with a model rather than against
 * a vocabulary, embeds it, searches Qdrant with payload filters, runs the
 * backend's full-text indexes in parallel, merges the two, applies the filters
 * strictly, and scores every candidate with `scoreCandidateAgainstRequirements`.
 * Database search opts into occupation evidence first and reviews up to twenty
 * profiles, including relevant careers with sparse skill tags (14 Oct).
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
import { employerMatch, excludedByEmployer, employersInText, describeEmployerHit } from "../../convex/lib/employers";
import { intentToEngineHints, readSearchIntent, searchKindOf, type SearchIntent, type SearchKind } from "@/lib/searchIntent";
import { convexQuery } from "@/lib/convexServer";
import { referenceProfileSearchText, type ReferenceSearchProfile } from "@/lib/referenceSearchProfile";
import { compareSearchCandidates, mergeSearchPool, quickRolePhrase, readOccupation, searchEvidenceReason, searchReviewPool, type RoleEvidence, type SearchOccupation } from "../../convex/lib/searchRoleEvidence";

export interface EngineHit {
  roleEvidence?: RoleEvidence;
  candidateId: Id;
  score: number;
  reason: string;
  breakdown?: {
    title?: string;
    skills?: string;
    experience?: string;
    location?: string;
    industry?: string;
    /** "works there now" / "worked there before", when a company was asked for. */
    employer?: string;
  };
  /** "Works at Dialog Axiata (2021–now)", when a company was asked for. */
  employerLine?: string;
}

export interface EngineSearch {
  /** How the engine read the sentence — what the chips can show. */
  interpretation: {
    searchOccupation?: SearchOccupation;
    searchText: string;
    industry?: string;
    seniority?: string;
    minYears?: number;
    interpretation: string;
    keywords: string[];
    /** The companies the candidates must have worked at, as the engine read them. */
    employers?: string[];
    employerScope?: "current" | "any";
    excludeEmployers?: string[];
    /** What the search was read as: a job description, a keyword list, a name or a role. */
    kind?: SearchKind;
  };
  /** Conversation memory read from the natural-language turns. It contains no
   *  candidate contact data or CV text; it is only the recruiter's intent. */
  intent: SearchIntent;
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
  referenceProfile: ReferenceSearchProfile | null = null,
): Promise<EngineSearch> {
  const args = engineArgs(query, criteria, limit, edited, referenceProfile);

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
export function cachedEngineSearch(query: string, criteria: SearchCriteria, limit = 60, edited = false, referenceProfile: ReferenceSearchProfile | null = null): EngineSearch | null {
  const held = engineCache.get(JSON.stringify(engineArgs(query, criteria, limit, edited, referenceProfile)));
  return held && Date.now() - held.at < ENGINE_CACHE_MS ? held.done : null;
}

/**
 * The same search with no model: the sentence goes straight to retrieval, and
 * the engine's deterministic score ranks what comes back, against requirements
 * read from the chips. About a second, where the full run is ten or more — so
 * the page shows this first and replaces it when `engineSearch` answers.
 */
export function quickEngineSearch(query: string, criteria: SearchCriteria, limit = 60, edited = false, referenceProfile: ReferenceSearchProfile | null = null): Promise<EngineSearch> {
  return runEngine(engineArgs(query, criteria, limit, edited, referenceProfile), false);
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

function engineArgs(query: string, criteria: SearchCriteria, limit: number, edited: boolean, referenceProfile: ReferenceSearchProfile | null) {
  /*
   * The search as a conversation (9 Oct): the messages arrive one per line,
   * and the model reads them in order, so a later "in Colombo instead"
   * replaces the place rather than sitting beside it. The words and the
   * vectors still search the messages joined into one request.
   */
  const turns = query.split(/\n+/).map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean);
  const referenceText = referenceProfile ? referenceProfileSearchText(referenceProfile) : "";
  return {
    query: [referenceText, turns.map((t) => t.replace(/[.\s]+$/, "")).join(". ")].filter(Boolean).join(". "),
    turns,
    referenceProfile,
    location: criteria.locations[0] ?? undefined,
    minExperience: criteria.minExperience ?? undefined,
    maxExperience: criteria.maxExperience ?? undefined,
    industry: edited ? criteria.industries[0] ?? undefined : undefined,
    // Terms every candidate must carry somewhere — skills, certifications,
    // summary or name. That is the desk's own meaning of a skill chip, so a
    // chip the recruiter set maps straight across.
    customFilters: edited && criteria.skills.length ? criteria.skills : undefined,
    // A company chip the recruiter set or removed is what they mean. Left to
    // the parser, its vocabulary only knows a sample of current employers, so
    // the model's reading is used instead.
    employers: edited ? criteria.employers : undefined,
    // "Not from Dialog" is a literal phrase, read exactly, like a place.
    excludeEmployers: criteria.excludeEmployers.length ? criteria.excludeEmployers : undefined,
    limit,
    edited,
    /** Read by the quick pass only; not part of what the engine is asked. */
    chips: { titles: criteria.titles, skills: criteria.skills, industries: criteria.industries, employers: criteria.employers },
  };
}

const NO_ACTOR = { id: null as string | null };
const MODEL = "deepseek/deepseek-v4-flash";
const FETCH_LIMIT = 100;
const POOL_CAP = 200;

/*
 * Backend reads shared between the quick pass and the full run (28 Oct).
 *
 * A new search starts both, and each searched the full-text indexes, searched
 * Qdrant and loaded the same few hundred candidate documents, one run's worth
 * of reads twice over. A read is now kept for SHARE_MS, so the second run (and
 * a reply typed a moment later) reuses it. Short on purpose: a CV that arrives
 * is in the next search after that. A failed read is dropped at once, so a
 * route that was down is asked again, and each caller still sees the failure.
 */
const SHARE_MS = 30_000;
const SHARE_MAX = 1_500;
const shared = new Map<string, { at: number; p: Promise<unknown> }>();

function share<T>(key: string, read: () => Promise<T>): Promise<T> {
  const held = shared.get(key);
  if (held && Date.now() - held.at < SHARE_MS) return held.p as Promise<T>;
  const p = read();
  const entry = { at: Date.now(), p };
  shared.set(key, entry);
  p.catch(() => {
    if (shared.get(key) === entry) shared.delete(key);
  });
  while (shared.size > SHARE_MAX) shared.delete(shared.keys().next().value!);
  return p;
}

/** The search-shaped documents for these people, each loaded once per SHARE_MS. */
async function searchDocs(ids: Id[]): Promise<LiveCandidate[]> {
  const now = Date.now();
  const held = (id: Id) => {
    const h = shared.get(`doc:${id}`);
    return h && now - h.at < SHARE_MS ? (h.p as Promise<LiveCandidate | null>) : null;
  };
  const missing = ids.filter((id) => !held(id));
  const fresh = new Map<Id, Promise<LiveCandidate | null>>();
  if (missing.length) {
    const byId = backend.candidateDocsByIds(NO_ACTOR, missing, "search").then((docs) => new Map(docs.map((d) => [d._id as string, d])));
    for (const id of missing) fresh.set(id, share(`doc:${id}`, () => byId.then((m) => m.get(id) ?? null)));
  }
  const docs = await Promise.all(ids.map((id) => fresh.get(id) ?? held(id) ?? Promise.resolve(null)));
  return docs.filter((d): d is LiveCandidate => d !== null);
}

const modules = () =>
  Promise.all([
    import("../../convex/lib/jdParser"),
    import("../../convex/cvs/cvScoring"),
    import("../../convex/lib/claudeFirst"),
    import("@/lib/claudeBridge"),
  ]).then(([parser, scoring, claudeFirst, bridge]) => {
    // The re-rank is Claude first, as in the backend. Here the subscription is
    // in this process, so it is asked directly, not over the network (6 Oct).
    claudeFirst.answerInProcess(async (task, system, prompt) => {
      const r = await bridge.askBridge({ task, system, prompt });
      if (!r.ok) console.warn(`[claude-first] ${task} → deepseek: ${r.reason}`);
      return r.ok ? r.text : null;
    });
    return { parser, scoring };
  });

type Requirements = import("../../convex/lib/jdParser").SearchRequirements;
type Scored = import("../../convex/cvs/cvScoring").ScoredCandidate;
type Doc = LiveCandidate & { vectorScore?: number };

/** The model's reading of a sentence depends on nothing else, so it is shared across chips. */
const intents = new Map<string, { at: number; value: ReturnType<typeof readSentence> }>();

function readSentence(parser: Awaited<ReturnType<typeof modules>>["parser"], turns: string[]) {
  const text = turns.join("\n");
  const settle = reserve("database search: read the query", maxModelCost(MODEL, 7000 + text.length, 1400));
  const run = parser.extractConversationRequirements(turns, { roleAware: true });
  run.then(
    (r) => settle(modelCost(MODEL, r.usage.promptTokens, r.usage.completionTokens)),
    () => settle(0),
  );
  return run;
}

function intentFor(parser: Awaited<ReturnType<typeof modules>>["parser"], turns: string[]) {
  const key = turns.join("\n").toLowerCase();
  const held = intents.get(key);
  if (held && Date.now() - held.at < ENGINE_CACHE_MS) return held.value;
  const value = readSentence(parser, turns);
  intents.set(key, { at: Date.now(), value });
  value.catch(() => intents.delete(key));
  while (intents.size > ENGINE_CACHE_MAX) intents.delete(intents.keys().next().value!);
  return value;
}

async function runEngine(args: EngineArgs, withModel: boolean): Promise<EngineSearch> {
  const { parser, scoring } = await modules();
  const q = args.query;
  const searchIntent = readSearchIntent(args.turns);
  const intentHints = intentToEngineHints(searchIntent);

  // 1 and 2 overlap: the words and the vectors are searched on the sentence
  // itself while the model reads it.
  const modelIntent = withModel ? intentFor(parser, args.turns) : null;
  // What was typed (28 Oct): a pasted JD, a keyword list, a name, or a role. A
  // reference CV is always a role-shaped search.
  const known = args.chips.titles.length + args.chips.skills.length + args.chips.industries.length + args.chips.employers.length > 0 || !!args.location;
  const { kind, keywords: listed } = args.referenceProfile ? { kind: "role" as SearchKind, keywords: [] as string[] } : searchKindOf(args.turns, known);
  // A keyword list means every keyword is in the profile, whether or not the
  // recruiter set chips.
  const filterArgs: EngineArgs = kind === "keywords" && !args.customFilters?.length ? { ...args, customFilters: listed } : args;
  const named = kind === "name" ? nameHits(args.turns[0]) : Promise.resolve([] as EngineHit[]);
  // Which routes failed. One down is fine — the other still answers — but an
  // empty answer with a route down is not "nothing matched": it was cached as
  // that for five minutes, and a refresh could not clear it (21 Sep).
  const down: string[] = [];
  const firstPass = Promise.all([
    vectorPool(q, args, down),
    // The latest message on its own too: "working at ABC" glued to the
    // messages before it is a weaker query than either alone.
    // A pasted JD is searched on what the model read out of it, not on its
    // 4,000 characters. Until then, or when the model is down, as before.
    (kind === "job_description" && modelIntent
      ? modelIntent.then((r) => (r.usage.model === "regex-fallback" ? [q.slice(0, 300)] : parser.buildSearchTerms(r.requirements, q))).catch(() => [q.slice(0, 300)])
      : Promise.resolve(kind === "keywords" ? listed : [q, ...args.turns.slice(-2).reverse(), ...args.chips.titles, ...args.chips.skills.slice(0, 3)])
    )
      .then((terms) => share(`kw:${JSON.stringify(terms)}`, () => backend.keywordSearchMany(NO_ACTOR, terms, FETCH_LIMIT)))
      .catch((e) => {
        down.push(`keyword search (${(e as Error)?.message ?? e})`);
        return [];
      }),
  ]);

  const reading = modelIntent ? await modelIntent.catch(() => null) : null;
  const parsed = reading && reading.usage.model !== "regex-fallback" ? reading.requirements : requirementsFromChips(args);
  const reference = args.referenceProfile;
  const occupation = reference
    ? {
        targetOccupation: reference.role,
        equivalentTitles: reference.alternativeTitles,
        reportingContext: null,
        explicitSkills: intentHints.mustHave,
        inferredSkills: [...reference.coreSkills, ...reference.supportingSkills],
      }
    : kind === "keywords"
      ? { targetOccupation: null, equivalentTitles: [], reportingContext: null, explicitSkills: listed, inferredSkills: [] }
      : readOccupation(parsed, q, [...(args.customFilters ?? []), ...intentHints.mustHave]);
  const req: Requirements = {
    ...parsed,
    title: reference?.role ?? parsed.title,
    alternativeTitles: reference ? [...new Set([...reference.alternativeTitles, ...(parsed.alternativeTitles ?? [])])].slice(0, 8) : parsed.alternativeTitles,
    searchOccupation: occupation,
    industry: args.industry ?? reference?.industries[0] ?? parsed.industry,
    location: args.location ?? parsed.location,
    minYearsExperience: args.minExperience && args.minExperience > 0 ? args.minExperience : reference?.minYears ?? reference?.totalExperienceYears ?? parsed.minYearsExperience ?? null,
    maxYearsExperience: args.maxExperience ?? reference?.maxYears ?? parsed.maxYearsExperience ?? null,
    seniority: reference?.seniority ?? parsed.seniority,
    education: reference?.education[0] ?? parsed.education,
    summary: reference
      ? `${reference.role}; comparable career level and experience; core skills ${reference.coreSkills.join(", ") || "not stated"}.`
      : parsed.summary,
    employers: args.employers ?? parsed.employers ?? [],
    excludeEmployers: [...new Set([...(args.excludeEmployers ?? []), ...(parsed.excludeEmployers ?? [])])],
    // Conversational intent is a hint layer over the engine, not a replacement:
    // explicit "must have" language tightens scoring, while "preferred" remains
    // a boost. The strict desk chips still own hard filters.
    requiredSkills: reference ? intentHints.mustHave : occupation.explicitSkills,
    preferredSkills: [...new Set([
      ...occupation.inferredSkills,
      ...(reference ? parsed.requiredSkills ?? [] : []),
      ...(reference ? parsed.preferredSkills ?? [] : []),
      ...intentHints.niceToHave,
    ])],
  };
  const employersAsked = req.employers ?? [];

  // The company asked for: everyone who worked there, from the employer
  // indexes. Vectors and words cannot know an employer, so these come first.
  const atCompany: Promise<{ candidateId: Id; score: number }[]> = employersAsked.length
    ? backend.employerSearch(NO_ACTOR, employersAsked, req.employerScope ?? "any", POOL_CAP).catch((e) => {
        down.push(`company search (${(e as Error)?.message ?? e})`);
        return [];
      })
    : Promise.resolve([]);

  // Reserve keyword capacity for occupation queries before broad skill terms.
  let secondPass: Promise<{ candidateId: Id }[]> = Promise.resolve([]);
  if (occupation.targetOccupation || modelIntent) {
    const terms = new Set<string>();
    if (occupation.targetOccupation) terms.add(occupation.targetOccupation);
    for (const t of occupation.equivalentTitles.slice(0, 3)) if (t) terms.add(t);
    terms.add(req.title && req.title.length > 2 ? req.title : q);
    const second = [...terms].slice(0, 6);
    secondPass = share(`kw:${JSON.stringify(second)}`, () => backend.keywordSearchMany(NO_ACTOR, second, FETCH_LIMIT)).catch((e) => {
      down.push(`keyword search (${(e as Error)?.message ?? e})`);
      return [];
    });
  }
  const [[vectors, words], more, employed] = await Promise.all([firstPass, secondPass, atCompany]);
  if (down.length && vectors.length + words.length + more.length + employed.length === 0) {
    console.warn(`[database search] no results with ${down.join("; ")}`);
    throw new Error("The search could not reach part of the database just now, so this is not a real \"nothing found\". Try again in a moment.");
  }

  // Separate allocations: a full vector response must not erase keyword-only
  // candidates. Company and occupation queries take priority within keywords.
  const vectorScore = new Map<Id, number>();
  for (const v of vectors) if (!vectorScore.has(v.candidateId)) vectorScore.set(v.candidateId, v.score);
  const ids = mergeSearchPool([...employed, ...more, ...words].map(w => w.candidateId), [...vectorScore.keys()]);

  // The search shape: summary, past titles and every employer, which the
  // score reads and a plain list leaves out (9 Oct).
  const docs = await searchDocs(ids as Id[]);
  const byId = new Map(docs.map((d) => [d._id, d]));
  const pool: Doc[] = ids.flatMap((id) => {
    if (reference?.sourceCandidateId === id) return [];
    const d = byId.get(id);
    // Anyone whose CV file was lost in the Cloud move is left out (src/lib/cvMissing.ts).
    // No vector score means unavailable evidence, not zero similarity.
    const similarity = vectorScore.get(id);
    return d && !d.cvFileMissing ? [{ ...d, vectorScore: similarity }] : [];
  });
  const nameFirst = await named;
  if (pool.length === 0) {
    return { interpretation: interpretationOf(req, modelIntent !== null, kind), intent: searchIntent, hits: nameFirst };
  }

  // Explicit constraints remain enforced even when nobody satisfies them.
  const candidates = strictFilters(pool, filterArgs, req);

  // 4. The engine's weighted score.
  const ranked = candidates
    .map((doc, i) => scoring.scoreCandidateAgainstRequirements(doc as never, req, i, { pastTitles: true, searchOccupation: occupation }))
    .sort((a, b) => compareSearchCandidates(a, b));

  // 5. Protect sparse-skill careers as well as high-ranking uncertain profiles.
  const verdicts = new Map<number, { score: number; reason: string }>();
  if (withModel) {
    const ambiguous = searchReviewPool(ranked);
    if (ambiguous.length > 0) {
      const settle = reserve("database search: re-rank", maxModelCost(MODEL, 30000, 4000));
      try {
        const { evaluations, usage } = await scoring.scoreBatchWithLLM(ambiguous, req, "search_ranking", { roleAware: true });
        settle(modelCost(MODEL, usage.promptTokens ?? 0, usage.completionTokens ?? 0));
        for (const [index, v] of evaluations) {
          if (ambiguous.some(c => c.index === index) && Number.isFinite(v.score)) verdicts.set(index, v);
        }
      } catch {
        // As the action does: the deterministic score stands.
        settle(0);
      }
    }
  }

  const final = ranked
    .map((c) => ({ c, score: verdicts.get(c.index)?.score ?? c.overallScore, reason: verdicts.get(c.index)?.reason ?? searchEvidenceReason(c.roleEvidence, c.cv.currentTitle ?? "", [...c.missingRequired, ...req.preferredSkills.filter(s => !c.matchedPreferred.some(m => m.toLowerCase() === s.toLowerCase()))]) }))
    .sort((a, b) => compareSearchCandidates(a.c, b.c, a.score, b.score));

  const onName = new Set<string>(nameFirst.map((h) => h.candidateId));
  return {
    interpretation: interpretationOf(req, modelIntent !== null, kind),
    intent: searchIntent,
    hits: [...nameFirst, ...final
      .filter((f) => !onName.has(f.c.cv._id) && (f.score > 0 || !!f.c.roleEvidence))
      .slice(0, args.limit)
      .map((f) => ({
        candidateId: f.c.cv._id,
        score: Math.round(f.score),
        reason: f.reason,
        roleEvidence: f.c.roleEvidence,
        breakdown: breakdownOf(f.c, req),
        ...(f.c.employerHit ? { employerLine: describeEmployerHit(f.c.employerHit) } : {}),
      }))],
  };
}

/**
 * People whose name is what was typed (28 Oct). `quickSearch` reads names and
 * titles, so a hit counts only when every typed word is in the person's name.
 * A word taken for a name that is not one finds nobody here and the normal
 * engine answers as before.
 */
async function nameHits(text: string): Promise<EngineHit[]> {
  try {
    const ids = await convexQuery<string[]>("ta/candidates:quickSearch", { q: text });
    if (!ids?.length) return [];
    const docs = await backend.candidateDocsByIds(NO_ACTOR, ids.slice(0, 12) as Id[], "search");
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return docs
      .filter((d) => !d.cvFileMissing && words.every((w) => String(d.fullName ?? "").toLowerCase().includes(w)))
      .map((d) => ({ candidateId: d._id, score: 100, reason: "Name match", breakdown: {} }));
  } catch {
    return [];
  }
}

/** Meaning: the query embedded the same way the index was, the nearest 200. */
async function vectorPool(q: string, args: EngineArgs, down: string[] = []): Promise<{ candidateId: Id; score: number }[]> {
  try {
    const e = await embedQuery(q);
    if (!e.ok) {
      down.push("meaning search (the query could not be embedded)");
      return [];
    }
    const filtered = !!args.minExperience || (args.maxExperience != null && args.maxExperience < 20);
    const near = (f: { minExperience: number | null; maxExperience: number | null } | undefined) =>
      share(`vec:${q}:${f ? `${f.minExperience}:${f.maxExperience}` : "any"}`, () => (f ? searchVectors(e.vectors[0], 200, f) : searchVectors(e.vectors[0], 200)));
    const hits = await near({ minExperience: args.minExperience ?? null, maxExperience: args.maxExperience ?? null });
    // As the action does: a filtered search that finds nobody usually means the
    // index lacks the field, so ask by meaning alone.
    return hits.length > 0 || !filtered ? hits : await near(undefined);
  } catch (err) {
    // Either route can be down without the other stopping.
    down.push(`meaning search (${(err as Error)?.message ?? err})`);
    return [];
  }
}

/** The action's `applyFiltersStrictly`, for the arguments this screen sends. */
function strictFilters(list: Doc[], args: EngineArgs, req: Requirements): Doc[] {
  let out = list;
  // A named company keeps only people who worked there, now or before.
  const employers = req.employers ?? [];
  if (employers.length) {
    out = out.filter((c) => employerMatch(employers, c as never, req.employerScope ?? "any") !== null);
  }
  if (req.excludeEmployers?.length) {
    out = out.filter((c) => !excludedByEmployer(req.excludeEmployers!, c as never));
  }
  if (args.location) {
    const want = args.location.toLowerCase().trim();
    out = out.filter((c) => {
      const at = (c.location || "").toLowerCase();
      if (want === "remote") return ["remote", "wfh", "home", "work from home"].some((w) => at.includes(w));
      return at.includes(want);
    });
  }
  const years = (c: Doc) => c.totalExperienceYears ?? (c as { yearsOfExperience?: number }).yearsOfExperience;
  // The chips, else what the model read ("two years" written in words). A
  // reference CV's own range is a score, not a filter, so it is left out.
  const own = !args.referenceProfile;
  const minYears = args.minExperience && args.minExperience > 0 ? args.minExperience : own ? req.minYearsExperience ?? undefined : undefined;
  const maxYears = args.maxExperience ?? (own ? req.maxYearsExperience ?? undefined : undefined);
  if (minYears !== undefined && minYears > 0) {
    out = out.filter((c) => years(c) == null || years(c)! >= minYears);
  }
  if (maxYears !== undefined && maxYears < 20) {
    out = out.filter((c) => years(c) == null || years(c)! <= maxYears);
  }
  if (args.customFilters?.length) {
    out = out.filter((c) => {
      const skills = ((c.skills ?? []) as unknown[]).map((s) => (typeof s === "string" ? s : String((s as { value?: string }).value ?? "")).toLowerCase());
      const certs = ((c.certifications ?? []) as string[]).map((x) => x.toLowerCase());
      const summary = String((c as { summary?: string }).summary ?? "").toLowerCase();
      const name = String(c.fullName ?? "").toLowerCase();
      // Titles and companies too: "Big 4" or "SAP" is as likely to be in a job
      // line as in the skills list.
      const r = c as unknown as { currentTitle?: string; currentJobTitle?: string; pastJobTitles?: string[]; currentEmployer?: string; employersText?: string; jobHistory?: { title?: string }[] };
      const career = [r.currentTitle, r.currentJobTitle, ...(r.pastJobTitles ?? []), ...(r.jobHistory ?? []).map((j) => j.title), r.currentEmployer, r.employersText].filter(Boolean).join(" ").toLowerCase();
      return args.customFilters!.every((f) => {
        const t = f.toLowerCase().trim();
        return !t || skills.some((s) => s.includes(t)) || certs.some((x) => x.includes(t)) || summary.includes(t) || name.includes(t) || career.includes(t);
      });
    });
  }
  if (args.industry) {
    out = out.filter(c => (c.industries ?? []).some((i: string) => i.toLowerCase().includes(args.industry!.toLowerCase())));
  }
  return out;
}

function breakdownOf(c: Scored, req: Requirements): EngineHit["breakdown"] {
  const cv = c.cv as Scored["cv"] & { totalExperienceYears?: number };
  const years = cv.yearsOfExperience ?? cv.totalExperienceYears ?? 0;
  return {
    title: c.titleScore >= 90 ? "strong match" : c.titleScore >= 70 ? "partial match" : "loose match",
    skills: c.skillScore >= 80 ? "strong match" : c.skillScore >= 50 ? "partial match" : "loose match",
    experience:
      req.maxYearsExperience != null && years > req.maxYearsExperience ? "above range"
      : req.minYearsExperience != null ? (years >= req.minYearsExperience ? "meets target" : "below range")
      : "not specified",
    location: c.locationStatus === "match" ? "match" : c.locationStatus === "different" ? "different" : "not specified",
    industry: c.industryScore === 100 ? "match" : "different",
    ...(c.employerHit ? { employer: c.employerHit.when === "current" ? "works there now" : "worked there before" } : {}),
  };
}

function interpretationOf(req: Requirements, read: boolean, kind?: SearchKind): EngineSearch["interpretation"] {
  return {
    kind,
    searchOccupation: req.searchOccupation,
    searchText: [req.title, ...req.alternativeTitles, ...req.requiredSkills.slice(0, 4)].filter(Boolean).join(" "),
    industry: req.industry ?? undefined,
    seniority: req.seniority ?? undefined,
    minYears: req.minYearsExperience ?? undefined,
    // Empty until a model has read the sentence: the chips are not a reading of it.
    interpretation: read ? req.summary : "",
    keywords: read ? req.keywords : [],
    employers: req.employers?.length ? req.employers : undefined,
    employerScope: req.employerScope,
    excludeEmployers: req.excludeEmployers?.length ? req.excludeEmployers : undefined,
  };
}

/** The chips, in the engine's shape — what the quick pass ranks against. */
function requirementsFromChips(args: EngineArgs): Requirements {
  const phrase = args.edited && args.chips.titles.length ? args.chips.titles[0] : quickRolePhrase(args.turns.join("\n"));
  const onlySkills = !args.chips.titles.length && args.chips.skills.some(s => s.toLowerCase() === phrase.toLowerCase());
  return {
    title: phrase,
    ...(onlySkills ? { searchOccupation: { targetOccupation: null, equivalentTitles: [], reportingContext: null, explicitSkills: args.chips.skills, inferredSkills: [] } } : {}),
    alternativeTitles: args.chips.titles.slice(1),
    occupationSynonyms: [],
    requiredSkills: args.edited ? args.chips.skills : [],
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
    // Before the model has read the messages: the company chips, or failing
    // that a company named after "at", "in" or "from" ("HR people at Dialog").
    ...companiesBeforeTheModel(args),
  };
}

function companiesBeforeTheModel(args: EngineArgs): Pick<Requirements, "employers" | "employerScope" | "excludeEmployers"> {
  const read = employersInText(args.turns.join(". "));
  return {
    employers: args.employers ?? (args.chips.employers.length ? args.chips.employers : read.employers),
    employerScope: read.scope,
    excludeEmployers: [...(args.excludeEmployers ?? []), ...read.excludeEmployers],
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
  "above range": 35,
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
  if (hit.employerLine) {
    explanation.push({ part: "Title", score: null, weight: null, points: 0, detail: `Company: ${hit.employerLine}.` });
  }
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
  // The company asked for, as this person's CV names it.
  if (hit.employerLine) hits.push(hit.employerLine);
  if (b.experience === "below range" && criteria.minExperience != null) {
    misses.push(`${criteria.minExperience}+ years`);
  }
  if (b.experience === "above range" && criteria.maxExperience != null) {
    misses.push(`up to ${criteria.maxExperience} years`);
  }
  return { hits: [...new Set(hits.filter(Boolean))], misses: [...new Set(misses)] };
}
