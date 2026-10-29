import Link from "next/link";
import { Suspense } from "react";
import { Pager } from "@/components/Pager";
import { repo } from "@/data/store";
import { assess } from "@/lib/assessment";
import { FIT_BANDS, type Score } from "@/lib/scoring";
import { pageUser } from "@/lib/session";
import { STAGE_LABEL } from "@/data/types";
import { FILTER_PARAMS, conversationText, criteriaFromParams, criteriaToParams, describe, parseBoolean, parseConversation, resultsKeyOf, searchParamsOf, turnsOf, withoutChip, withValue } from "@/lib/query";
import { SearchBox } from "@/components/db/SearchBox";
import { AiPanel } from "@/components/db/AiPanel";
import { ResultRow, type RowApp } from "@/components/db/ResultRow";
import { DbCandidateDrawer } from "@/components/db/DbCandidateDrawer";
import { DATABASE_STEPS, LoadingProgress } from "@/components/LoadingScenes";
import { booleanScore, booleanTerms } from "@/lib/booleanScore";
import { addManyToOpening, saveSearch } from "@/app/actions";
import { isWordFile } from "@/lib/wordToPdf";
import { BulkBar, DownloadCvsButton } from "@/components/BulkSelect";
import { SubmitButton } from "@/components/Submit";
import { BELOW_BAR, RELEVANT_SIMILARITY, embedQuery, isMeaningBased, nearestCandidates } from "@/lib/embed";
import { refreshCandidateVectors } from "@/lib/dbMatch";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import type { DrawerCv } from "@/components/db/DbCandidateDrawer";
import { keywordRetrieve } from "@/lib/retrieve";
import { levelOptions } from "@/lib/levels";
import { LevelFilter } from "@/components/db/LevelFilter";
import { FacetFilter } from "@/components/db/FacetFilter";
import { ExperienceRange } from "@/components/db/ExperienceRange";
import { EXPERIENCE_MAX, FACETS, anyActive, facetOptions, hiddenForUnknownYears, pickedFrom, rowMatches } from "@/lib/facets";
import {
  cachedEngineSearch,
  deskCriteria,
  engineSearch,
  hitsAndMisses,
  quickEngineSearch,
  scoreFromEngine,
  type EngineHit,
  type EngineSearch,
} from "@/lib/engineSearch";
import type { SearchCriteria } from "@/data/types";
import { parseReferenceProfile, type ReferenceSearchProfile } from "@/lib/referenceSearchProfile";
import { safeErrorMessage } from "@/lib/userError";

const PAGE = 25;
const ENGINE_LIMIT = 400;

type Params = Record<string, string | string[] | undefined>;

/**
 * The page frame renders at once; the results stream in.
 *
 * A search can take twenty seconds — a model reads the sentence and a second one
 * re-scores the uncertain band — and a server page that waited for all of it
 * sent nothing until then, so the screen looked stuck. The frame, the search box
 * and a "Searching" note are sent immediately, and the results replace the note
 * when they are ready.
 *
 * The boundary is keyed on the search itself (not the page or the open
 * candidate), so a new search shows the note straight away, while paging and
 * opening a candidate — both answered from the search cache in a fraction of a
 * second — keep the list on screen.
 */
export default async function ResultsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  await pageUser("database.read");
  const q = typeof sp.q === "string" ? sp.q : "";
  const mode = sp.mode === "boolean" ? "boolean" : sp.mode === "meaning" ? "meaning" : "natural";
  const forOpening = typeof sp.for === "string" ? sp.for : null;
  const referenceParam = typeof sp.ref === "string" && parseReferenceProfile(sp.ref) ? sp.ref : "";
  // The conversation's first message, not every reply: a reply keeps the list on
  // screen while the new answer comes (query.ts resultsKeyOf).
  const searchKey = resultsKeyOf(sp);

  return (
    <main className="px-6 py-5">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/database" className="text-[12.5px] text-ink-soft hover:text-ink">← Database</Link>
        {forOpening && (
          <span className="rounded-full bg-brand-soft px-3 py-1 text-[11.5px] text-brand">
            Searching for {repo.opening(forOpening)?.title ?? "an opening"}
          </span>
        )}
      </div>
      <Suspense key={searchKey} fallback={<Searching q={q} mode={mode} forOpening={forOpening} referenceParam={referenceParam} />}>
        <Results sp={sp} />
      </Suspense>
    </main>
  );
}

/** What is on screen while a new search runs: the same frame, the box still usable. */
function Searching({ q, mode, forOpening, referenceParam }: { q: string; mode: "natural" | "boolean" | "meaning"; forOpening: string | null; referenceParam: string }) {
  const vocab = repo.vocabulary();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[400px_1fr]">
      <aside className="flex flex-col gap-3 xl:sticky xl:top-[80px] xl:max-h-[calc(100vh-96px)] xl:overflow-y-auto xl:overscroll-contain xl:pb-2">
        <div className="rounded-xl border border-rule bg-surface p-4">
          <SearchBox
            vocab={[...vocab.titles, ...vocab.skills, ...vocab.industries, ...vocab.cities, ...vocab.employers]}
            prior={q}
            initialMode={mode}
            openingId={forOpening}
            referenceProfile={referenceParam}
            compact
          />
        </div>
      </aside>
      <div className="min-w-0">
        {q ? (
          <LoadingProgress
            steps={DATABASE_STEPS}
            heading={`Searching for “${(turnsOf(q).at(-1) ?? q).slice(0, 80)}${(turnsOf(q).at(-1) ?? q).length > 80 ? "…" : ""}”`}
            note="a new search can take up to half a minute; the same search again is instant"
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-rule bg-surface px-8 py-16 text-center" role="status" aria-live="polite">
            <p className="text-[14px] font-medium">Loading the results…</p>
          </div>
        )}
      </div>
    </div>
  );
}

async function Results({ sp }: { sp: Params }) {
  await primeStore({ allApplications: true });
  const q = typeof sp.q === "string" ? sp.q : "";
  const mode = sp.mode === "boolean" ? "boolean" : sp.mode === "meaning" ? "meaning" : "natural";
  const forOpening = typeof sp.for === "string" ? sp.for : null;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const candidateId = typeof sp.candidate === "string" ? sp.candidate : null;
  const referenceParam = typeof sp.ref === "string" ? sp.ref : "";
  const referenceProfile = parseReferenceProfile(referenceParam);
  if (candidateId && isConvex()) {
    await primeStore({ candidateIds: [candidateId] });
  }
  const vocab = repo.vocabulary();

  // The sentence is parsed once; after that the URL's criteria win, so removing
  // a chip actually removes it rather than being re-derived from the text.
  const edited =
    (sp as Record<string, string | undefined>).edited === "1" ||
    criteriaToParams(criteriaFromParams(sp)).toString().length > 0;
  // By meaning still reads the sentence for the strict parts — place, years,
  // notice, salary — and lets the similarity rank everything else.
  // Every message of the conversation, a later one winning where they disagree (5 Oct).
  const parsed = mode !== "boolean" ? parseConversation(q, vocab) : null;
  const criteria = edited ? criteriaFromParams(sp) : (parsed?.criteria ?? criteriaFromParams(sp));
  const ignored = edited ? [] : (parsed?.ignored ?? []);
  const booleanError = mode === "boolean" ? parseBoolean(q).error : null;
  const view: ViewProps = { sp, q, mode, forOpening, page, candidateId, vocab, edited, criteria, ignored, booleanError, referenceParam, referenceProfile };

  /*
   * How the engine's answer reaches the screen.
   *
   * The engine runs for the ordinary case — Boolean is a literal word search
   * and by-meaning a deliberate request for raw similarity, both the recruiter
   * overriding the ranking on purpose.
   *
   * A full run reads the sentence with a model and has a second model re-rank
   * the uncertain band: ten seconds or more, most of it waiting on those two
   * calls. So unless the answer is already held (page 2, back from a profile),
   * the same retrieval is ranked by the engine's deterministic score first —
   * about a second — and the page shows that while the full run streams in
   * behind it and replaces it.
   */
  if (isConvex() && q && mode === "natural") {
    // The engine gets the messages one per line, not joined: it reads them as
    // a conversation, a later message changing an earlier one (9 Oct).
    const held = cachedEngineSearch(q, criteria, ENGINE_LIMIT, edited, referenceProfile);
    if (held) return <ResultsView {...view} engine={held} />;
    const full = engineSearch(q, criteria, ENGINE_LIMIT, edited, referenceProfile);
    // Started above, so an unawaited failure here is not an unhandled one; the
    // streamed half reports it.
    full.catch(() => undefined);
    let quick: EngineSearch | null = null;
    try {
      quick = await quickEngineSearch(q, criteria, ENGINE_LIMIT, edited, referenceProfile);
    } catch {
      // No quick answer: wait for the full one, as before.
    }
    if (!quick) return <EngineResults {...view} full={full} />;
    return (
      <Suspense fallback={<ResultsView {...view} engine={quick} refining />}>
        <EngineResults {...view} full={full} />
      </Suspense>
    );
  }
  return <ResultsView {...view} />;
}

interface ViewProps {
  sp: Params;
  q: string;
  mode: "natural" | "boolean" | "meaning";
  forOpening: string | null;
  page: number;
  candidateId: string | null;
  vocab: ReturnType<typeof repo.vocabulary>;
  edited: boolean;
  criteria: SearchCriteria;
  ignored: string[];
  booleanError: string | null;
  referenceParam: string;
  referenceProfile: ReferenceSearchProfile | null;
}

/** The streamed half: the engine's full answer, or the words when it cannot run. */
async function EngineResults({ full, ...view }: ViewProps & { full: Promise<EngineSearch> }) {
  try {
    return <ResultsView {...view} engine={await full} />;
  } catch (e) {
    return <ResultsView {...view} engineError={safeErrorMessage(e, "The search could not run. Try again.")} />;
  }
}

async function ResultsView({
  sp,
  q,
  mode,
  forOpening,
  page,
  candidateId,
  vocab,
  edited,
  criteria,
  ignored,
  booleanError,
  referenceParam,
  referenceProfile,
  engine,
  engineError,
  refining = false,
}: ViewProps & {
  /** The engine's answer, when it ran. */
  engine?: EngineSearch;
  /** Why the engine could not run, when it could not; the words stand in. */
  engineError?: string;
  /** `engine` is the quick deterministic pass and the full one is still coming. */
  refining?: boolean;
}) {
  // Searched once, in full. The spotlight counts below were taken from a list
  // cut to 25 × the page number, so they changed as you paged (audit finding
  // 37); they now describe every match, the same set the headline counts.
  let similarity: Map<string, number> | undefined;
  let meaningProblem: string | null = null;
  let retrievalProblem: string | null = null;

  /*
   * Retrieval, before anything is filtered.
   *
   * On the file store the whole database is already in memory, so a search is
   * a filter over it. Backed by Convex it is not: the working set holds the
   * people this page primed and nobody else, so filtering it would search a
   * few hundred rows and confidently report that nothing matched.
   *
   * So somebody has to go and find people first, and that finding is the whole
   * problem at this size — the hard part is not filtering a list, it is being
   * good at turning up people whose CV never uses the words the recruiter
   * typed. The matching engine already does it, and does it well enough that
   * the desk corrected it into its present shape over months rather than
   * replacing it. Its own functions run it (lib/engineSearch); the page above
   * decides whether this render has its quick answer or its full one.
   */
  let engineHits = new Map<string, EngineHit>();
  let engineRead: string | null = null;
  let engineTerms: string[] | null = null;
  let engineKind: string | null = null;
  let engineCompanies: { names: string[]; scope: "current" | "any"; exclude: string[] } | null = null;
  const searchIntent = engine?.intent ?? null;

  if (engine) {
    /*
     * The engine does the finding and the ranking.
     *
     * It reads the sentence with a model rather than against a vocabulary,
     * searches Qdrant and the full-text indexes together, and scores what
     * comes back with the rules the desk corrected over months. Its order is
     * the order shown.
     *
     * The platform's own criteria still apply on top — place, years, notice,
     * salary, availability — because those are the desk's rules about who
     * may be approached, and the engine has no notion of them. They narrow
     * the engine's list; they never reorder it.
     */
    engineHits = new Map(engine.hits.map((h) => [h.candidateId, h]));
    engineRead = engine.interpretation?.interpretation || null;
    engineTerms = engine.interpretation?.keywords?.length ? engine.interpretation.keywords : null;
    const read = engine.interpretation;
    engineKind = read?.kind ?? null;
    if (read?.employers?.length || read?.excludeEmployers?.length) {
      engineCompanies = { names: read.employers ?? [], scope: read.employerScope ?? "any", exclude: read.excludeEmployers ?? [] };
    }
    await primeStore({ candidateIds: engine.hits.map((h) => h.candidateId) });
    // Fed in as the ranking signal the existing filter path already accepts,
    // scaled to its 0–1 scale. The floor is 0: the engine has already
    // decided who is worth showing and applies its own safety floor.
    similarity = new Map(engine.hits.map((h) => [h.candidateId, h.score / 100]));
    if (engine.hits.length === 0) retrievalProblem = "Nothing in the database matched that search.";
  } else if (engineError !== undefined) {
    // The engine needs a model. Where it cannot run, the words still can —
    // the backend's full-text indexes need no key at all, so the screen
    // degrades to a worse search rather than to an empty one.
    retrievalProblem = `Ranked on words only — the matching engine could not run (${engineError}).`;
    try {
      const terms = [conversationText(q), ...criteria.titles, ...criteria.skills.slice(0, 3), ...criteria.employers.slice(0, 2)];
      const hits = await keywordRetrieve(terms, 150);
      await primeStore({ candidateIds: hits });
    } catch (inner) {
      retrievalProblem = safeErrorMessage(inner, "The database could not be searched. Try again.");
    }
  }

  /*
   * Boolean reads the words of every CV, but it can only read the CVs in the
   * working set — and on the live desk that is the ~740 people loaded for
   * follow-ups, not the 78,000 in the database. So "java AND …" answered from
   * 740 CVs (21 September). Fetch everyone whose title, skills, summary or CV
   * text holds one of the positive terms first; the expression is then
   * checked on each of them as before.
   */
  if (mode === "boolean" && q && isConvex() && !booleanError) {
    const terms = booleanTerms(q);
    if (terms.length > 0) {
      try {
        const hits = await keywordRetrieve(terms, 1200);
        await primeStore({ candidateIds: hits });
      } catch (e) {
        retrievalProblem = safeErrorMessage(e, "The database could not be searched. Try again.");
      }
    }
  }

  if (mode === "meaning" && q) {
    // Backed by Convex the vectors are Qdrant's, built by the reindexer — the
    // same reason findDatabaseMatches skips this. Refreshing the local file
    // here re-embedded every primed candidate: ~17 s and a paid API call.
    const vectors = isConvex() ? { ok: true as const } : await refreshCandidateVectors();
    const query = vectors.ok ? await embedQuery(conversationText(q)) : vectors;
    if (query.ok) {
      const hits = await nearestCandidates(query.vectors[0], 1000);
      similarity = new Map(hits.map((n) => [n.id, n.similarity]));
      // The rows have to be in the working set before `repo` can read them.
      await primeStore({ candidateIds: hits.map((h) => h.id) });
    } else {
      meaningProblem = `Search by meaning could not run (${query.reason}), so these are ranked on the words.`;
      // Fall back to the word route rather than showing an empty page: the
      // working set holds only what this page primed, and it has primed
      // nobody yet.
      if (isConvex()) {
        try {
          const hits = await keywordRetrieve([conversationText(q), ...criteria.titles], 150);
          await primeStore({ candidateIds: hits });
        } catch (e) {
          retrievalProblem = safeErrorMessage(e, "The database could not be searched. Try again.");
        }
      }
    }
  }
  // Below this a candidate is not close enough to count as a result at all.
  // Similarity has no fixed scale across queries — a long, specific sentence
  // scores everyone lower than a short one — so the bar is set against the
  // closest CV in the database: within 0.12 of the best, and never under 0.25.
  const best = similarity ? Math.max(0, ...similarity.values()) : 0;
  const showBelow = (sp as Record<string, string | undefined>).below === "1";
  const engineRanked = !!engine;
  const referenceRanked = engineRanked && !!referenceProfile;
  const engineOrder = new Map([...engineHits.keys()].map((id, index) => [id, index]));
  /*
   * The bar below is a bar on cosine similarity, and the engine's number is not
   * one — it is a fit score out of 100 with its own thresholds, already applied
   * before it returned. Judging it against a similarity bar would cut people the
   * engine had passed, for a reason that does not apply to them. So when the
   * engine ranked the list the bar is zero: everyone it sent back is shown, in
   * its order, and the criteria below still narrow them.
   */
  const bar = referenceRanked ? FIT_BANDS.worth / 100 : engineRanked ? 0 : isMeaningBased() ? RELEVANT_SIMILARITY : Math.max(0.08, best * 0.6);
  const floor = referenceRanked ? (showBelow ? 0 : bar) : engineRanked ? 0 : showBelow ? bar - (isMeaningBased() ? BELOW_BAR : 0.04) : bar;
  // What is still ours to enforce. Where the engine ran it has already applied
  // place and years against its own fields; see `deskCriteria`.
  const narrowing = engineRanked ? deskCriteria(criteria) : criteria;
  const { results, total: foundTotal, scanned, below } = repo.searchDatabase(narrowing, {
    boolean: mode === "boolean" ? q : null,
    limit: Number.MAX_SAFE_INTEGER,
    similarity,
    floor,
    belowFloor: showBelow ? undefined : referenceRanked ? 0 : bar - (isMeaningBased() ? BELOW_BAR : 0.04),
  });
  /*
   * One score, not two.
   *
   * Search used to print its own "82% match" from a second, older scorer. The
   * same candidate could read 82% here and 55 on the pipeline, for the same
   * role — different maths, different scale, both on screen.
   *
   * Those two numbers were answering different questions, which is why they
   * disagreed. Search relevance asks "does this person match what I typed".
   * Fit asks "does this person match the job". So the relevance number is gone
   * — it ranked the list and then confused people by staying visible — and
   * when a search is tied to an opening, the REAL fit score is shown, the same
   * one the lists use.
   */
  const target = forOpening ? repo.opening(forOpening) : null;
  const targetClient = target ? repo.client(target.clientId) : null;
  const fit = new Map<string, Score>();
  const assessment = target ? assess(target.id, results.map((r) => r.candidate)) : null;
  if (assessment?.ok) {
    for (const [id, score] of assessment.scores) fit.set(id, score);
  } else if (engineRanked) {
    /*
     * No opening to fit against, so the engine's own score stands in — the one
     * it ranked by, with the sentence it wrote explaining the position.
     *
     * This does not bring back the two-numbers problem above. That was one
     * candidate reading 82 here and 55 on the pipeline for the same job, from
     * two scorers. Here the job's score always wins where there is a job: the
     * engine's number appears only when there is no opening to compare
     * against, so the two are never on screen together.
     */
    for (const r of results) {
      const hit = engineHits.get(r.candidate.id);
      if (hit) fit.set(r.candidate.id, scoreFromEngine(hit));
    }
  } else if (mode === "boolean") {
    // No opening and no engine: score how well each CV carries the terms asked for.
    const terms = booleanTerms(q);
    for (const r of results) {
      const s = booleanScore(terms, r.candidate);
      if (s) fit.set(r.candidate.id, s);
    }
  }

  // The engine already orders career evidence before broad similarity. Keep
  // that order through pagination and profile navigation, even with a job fit.
  results.sort((a, b) => {
    if (engineRanked) return (engineOrder.get(a.candidate.id) ?? Infinity) - (engineOrder.get(b.candidate.id) ?? Infinity);
    const scoreA = fit.get(a.candidate.id)?.overall ?? (a.score > 1 ? a.score : Math.round(a.score * 100));
    const scoreB = fit.get(b.candidate.id)?.overall ?? (b.score > 1 ? b.score : Math.round(b.score * 100));
    return scoreB - scoreA || (b.candidate.totalExperienceYears ?? 0) - (a.candidate.totalExperienceYears ?? 0);
  });

  // The list stays in best-fit order. The levels it holds are a filter beside it
  // (8 Oct): they used to cut the list into sections under headings, which
  // buried the best fit under whichever level came first. The choices are
  // counted over the whole list; ticked ones narrow it before paging, so a page
  // never mixes the two.
  const levelChoices = levelOptions(target, results.map((r) => r.candidate));
  const pickedLevels = new Set(
    (Array.isArray(sp.lvl) ? sp.lvl : sp.lvl ? [sp.lvl] : []).filter((k) => levelChoices.some((o) => o.key === k)),
  );
  // The filters beside the list (lib/facets): Level, the experience range and the
  // tick lists narrow it together, strictly; clearing them returns all of it.
  const everyone = [...results];
  const picked = pickedFrom(sp, pickedLevels);
  const filtering = anyActive(picked);
  if (filtering) {
    results.splice(0, results.length, ...results.filter((r) => rowMatches(r, picked)));
  }
  const total = filtering ? results.length : foundTotal;
  const strongReferenceMatches = referenceProfile
    ? results.filter((r) => (engineHits.get(r.candidate.id)?.score ?? 0) >= FIT_BANDS.strong).length
    : 0;
  const broaderReferenceMatches = referenceProfile
    ? (engine?.hits ?? []).filter((hit) => hit.score < FIT_BANDS.worth).length
    : 0;

  const shown = results.slice((page - 1) * PAGE, page * PAGE);

  const openings = repo.openings().filter((o) => o.status === "open");
  const clients = repo.clients();
  const users = repo.users();
  const openingOptions = openings.map((o) => ({
    id: o.id,
    label: `${clients.find((c) => c.id === o.clientId)?.name ?? "—"} — ${o.title}`,
  }));

  const free = results.filter((r) => r.signals.some((s) => s.kind === "free")).length;
  const inPipe = results.filter((r) => r.signals.some((s) => s.kind === "in_pipeline")).length;
  const alumni = results.filter((r) => r.signals.some((s) => s.kind === "placed")).length;
  const quick = results.filter((r) => (r.candidate.noticePeriodDays ?? 999) <= 30).length;

  const base = "/database/results";
  const extra: Record<string, string> = {
    q,
    ...(mode !== "natural" ? { mode } : {}),
    ...(forOpening ? { for: forOpening } : {}),
    ...(referenceProfile ? { ref: referenceParam } : {}),
  };


  /*
   * Widening — only offered where it would actually find someone.
   *
   * Not offered at all when the engine ranked the list. The offer is computed
   * by re-running the search with one more city added, and the engine's list
   * was fetched for the cities that were asked for: adding a city to a filter
   * over people who were never retrieved finds nobody, so every suggestion
   * would read "+0" and the honest ones would be missing. Answering that needs
   * a second trip to the engine, which is a cost this row of chips does not
   * justify.
   */
  const suggestions: { label: string; found: number; href: string }[] = [];
  if (criteria.locations.length && !engineRanked) {
    // One search with the place dropped, counted by place — rather than the
    // whole search again per city (~350 of them, ~1.1 s). Place is an exact,
    // one-value match per candidate, so adding a city adds exactly the people
    // who live there and match everything else.
    const anywhere = repo.searchDatabase(
      { ...criteria, locations: [] },
      { boolean: mode === "boolean" ? q : null, limit: Number.MAX_SAFE_INTEGER, similarity, floor },
    );
    const byPlace = new Map<string, number>();
    for (const r of anywhere.results) {
      const place = (r.candidate.location ?? "").toLowerCase();
      byPlace.set(place, (byPlace.get(place) ?? 0) + 1);
    }
    const chosen = new Set(criteria.locations.map((l) => l.toLowerCase()));
    for (const city of vocab.cities.filter((c) => !criteria.locations.includes(c))) {
      const found = chosen.has(city.toLowerCase()) ? 0 : (byPlace.get(city.toLowerCase()) ?? 0);
      if (found > 0) suggestions.push({ label: city, found, href: `${base}${withValue(criteria, "locations", city, extra)}` });
    }
    suggestions.sort((a, b) => b.found - a.found);
  }

  // When nothing comes back, name the condition responsible rather than telling
  // the TA to guess at it.
  const blockers: { label: string; found: number; href: string }[] = [];
  if (total === 0 && mode !== "boolean" && !engineRanked && !filtering) {
    for (const chip of describe(criteria)) {
      const relaxed = criteriaFromParams(
        Object.fromEntries(new URLSearchParams(withoutChip(criteria, chip).slice(1))),
      );
      const found = repo.searchDatabase(relaxed, { limit: 1, similarity, floor }).total;
      if (found > 0) blockers.push({ label: chip.label, found, href: `${base}${withoutChip(criteria, chip, extra)}` });
    }
    blockers.sort((a, b) => b.found - a.found);
  }

  // These links keep the address as it is (searchParamsOf) and change only their
  // own part. Rebuilt from the parsed criteria they wrote chips into the URL, so
  // the next render read it as a new, edited search: the loading scene came back
  // and the engine ran again (28 Oct).
  const pageHref = (n: number) => {
    const p = searchParamsOf(sp, ["page", "candidate", "msg"]);
    p.set("page", String(n));
    return `${base}?${p.toString()}`;
  };

  // The level filter's links: the same search with one level ticked or unticked,
  // back on page one. Passing nothing clears them.
  const levelHref = (toggle?: string) => {
    const p = searchParamsOf(sp, ["page", "candidate", "msg", "lvl"]);
    const next = new Set(pickedLevels);
    if (toggle !== undefined) (next.has(toggle) ? next.delete(toggle) : next.add(toggle));
    for (const k of next) p.append("lvl", k);
    return `${base}?${p.toString()}`;
  };
  // A tick list's link: this option ticked or unticked, back on page one.
  const facetHref = (param: string, key: string) => {
    const p = searchParamsOf(sp, ["page", "candidate", "msg", param]);
    const next = new Set(picked.ticks.get(param));
    next.has(key) ? next.delete(key) : next.add(key);
    for (const k of next) p.append(param, k);
    return `${base}?${p.toString()}`;
  };
  const facetClearHref = (param: string) => `${base}?${searchParamsOf(sp, ["page", "candidate", "msg", param]).toString()}`;
  const clearFiltersHref = `${base}?${searchParamsOf(sp, ["page", "candidate", "msg", ...FILTER_PARAMS]).toString()}`;
  const rangeRest = searchParamsOf(sp, ["page", "candidate", "msg", "xmin", "xmax"]).toString();
  const facetBlocks = FACETS.map((f) => ({
    facet: f,
    options: facetOptions(f, everyone, picked).map((o) => ({ ...o, href: facetHref(f.param, o.key) })),
  })).filter((b) => b.options.length > 0);
  const hasYears = everyone.some((r) => r.candidate.totalExperienceYears != null);
  const showFilters = levelChoices.length >= 2 || hasYears || facetBlocks.length > 0;
  const broaderHref = (include: boolean) => {
    const p = searchParamsOf(sp, ["page", "candidate", "msg", "below"]);
    if (include) p.set("below", "1");
    return `${base}?${p.toString()}`;
  };

  /*
   * What a row says this person met and missed.
   *
   * The platform derives it by checking the criteria against the record. Where
   * the engine ran it has read the same person against the same sentence and
   * judged title, place and experience itself, so its reading is used and the
   * platform's is folded in behind it — neither alone names everything.
   */
  const rowChips = (r: { candidate: (typeof shown)[number]["candidate"]; hits: string[]; misses: string[] }) => {
    const hit = engineHits.get(r.candidate.id);
    if (!hit) return { hits: r.hits, misses: r.misses };
    const e = hitsAndMisses(hit, r.candidate, criteria, edited);
    const candidateSkills = (r.candidate.skills ?? []).map((skill) => skill.toLowerCase());
    const sharedReferenceSkills = referenceProfile?.coreSkills.filter((skill) => candidateSkills.some((have) => have.includes(skill.toLowerCase()) || skill.toLowerCase().includes(have))) ?? [];
    const missingReferenceSkill = referenceProfile?.coreSkills.find((skill) => !sharedReferenceSkills.includes(skill));
    const misses = [...new Set([...e.misses, ...(missingReferenceSkill ? [`Verify ${missingReferenceSkill}`] : []), ...r.misses])];
    // A thing the engine counted as met is not also missing, whatever the
    // platform's own check made of it.
    const hits = [...new Set([...e.hits, ...sharedReferenceSkills.slice(0, 4), ...r.hits])];
    return { hits, misses: misses.filter((m) => !hits.includes(m)) };
  };

  const rowIntentEvidence = ({ hits, misses }: { hits: string[]; misses: string[] }) => {
    if (!searchIntent) return undefined;
    const hitText = hits.join(" ").toLowerCase();
    const missText = misses.join(" ").toLowerCase();
    const asked = [...searchIntent.mustHave, ...searchIntent.niceToHave];
    const matched = asked.filter((term) => hitText.includes(term.toLowerCase()));
    const gaps = searchIntent.mustHave.filter((term) => missText.includes(term.toLowerCase()));
    const verify = searchIntent.unknowns
      .map((u) =>
        u === "location_strictness"
          ? "location flexibility"
          : u === "domain_priority"
            ? "industry priority"
            : u === "overqualification"
              ? "seniority tolerance"
              : u.replace(/_/g, " "),
      )
      .filter(Boolean);
    return { matched: [...new Set(matched)], verify: [...new Set(verify)], gaps: [...new Set(gaps)] };
  };

  const candidateHref = (id: string) => {
    const p = searchParamsOf(sp, ["candidate", "msg"]);
    p.set("candidate", id);
    return `${base}?${p.toString()}`;
  };

  const closeHref = `${base}?${searchParamsOf(sp, ["candidate", "msg"]).toString()}`;
  // "← Back to results" from a candidate's profile returns to exactly this list —
  // the search, every filter chip, the page. It used to keep only the sentence
  // and the page, so coming back re-read the sentence and lost the chips.
  const backToResults = closeHref;

  const activeCandidate = candidateId ? repo.candidate(candidateId) : null;
  const activeIndex = activeCandidate ? results.findIndex((r) => r.candidate.id === activeCandidate.id) : -1;
  const prevCandidateId = activeIndex > 0 ? results[activeIndex - 1].candidate.id : null;
  const nextCandidateId = activeIndex >= 0 && activeIndex < results.length - 1 ? results[activeIndex + 1].candidate.id : null;
  const activeStatus = activeCandidate ? repo.overallStatus(activeCandidate.id) : null;
  // The open candidate's own CV file, for the side panel. Only looked up, not
  // signed: the browser asks /api/cv for the file itself.
  // Not awaited: the drawer shows the profile at once and the CV section
  // fills in when the file's address is found (28 Oct). The lookup never
  // rejects, so an unread promise is not an unhandled one.
  let activeCv: Promise<DrawerCv | null> | null = null;
  if (activeCandidate && isConvex()) {
    const cand = activeCandidate;
    activeCv = (async (): Promise<DrawerCv> => {
      const found = await backend
        .cvFile(cand.id)
        .catch((e) => ({ ok: false as const, detail: safeErrorMessage(e, "The CV could not be loaded. Try again."), fileName: null }));
      const fileName = (found.ok ? found.fileName : null) ?? cand.cvFileName;
      const isPdf =
        found.ok &&
        (/pdf/i.test(found.fileType ?? "") ||
          /\.pdf$/i.test(fileName ?? "") ||
          !/\.(docx?|rtf|txt|png|jpe?g)$/i.test(fileName ?? ""));
      // A Word CV is shown as a PDF made from it (lib/wordToPdf); Download,
      // which adds download=1, still saves the Word file.
      const word = found.ok && !isPdf && isWordFile(fileName);
      return found.ok
        ? {
            href: `/api/cv/${encodeURIComponent(cand.id)}${word ? "?view=pdf" : ""}`,
            fileName,
            inline: isPdf || word,
            problem: null,
          }
        : { href: null, fileName, inline: false, problem: found.detail };
    })();
  }
  const statusLabel =
    activeStatus?.busy && activeStatus.stage
      ? activeStatus.stage === "placed"
        ? "Placed elsewhere"
        : `${STAGE_LABEL[activeStatus.stage]} on another opening`
      : null;

  const appsFor = (candidateId: string): RowApp[] =>
    repo.applicationsForCandidate(candidateId).map((a) => {
      const o = repo.opening(a.openingId);
      return {
        id: a.id,
        openingId: a.openingId,
        openingTitle: o?.title ?? "—",
        clientName: clients.find((c) => c.id === o?.clientId)?.name ?? "—",
        stageLabel: STAGE_LABEL[a.stage],
        ownerName: users.find((u) => u.id === a.ownerTaId)?.name ?? null,
        isLive: !["rejected", "dropped_out", "placed"].includes(a.stage),
        lastStageChangedAt: a.lastStageChangedAt,
        rejectReason: a.rejectReason ?? null,
      };
    });

  return (
    <>
      {/* Chat on the left, results in the middle, Level on the right (28 Oct). LevelFilter hides itself under two options, so the third column only exists when it has something to show. */}
      <div className={`grid grid-cols-[minmax(0,1fr)] items-start gap-6 ${showFilters ? "xl:grid-cols-[400px_1fr_240px]" : "xl:grid-cols-[400px_1fr]"}`}>
        <aside className="flex flex-col gap-3 xl:sticky xl:top-[80px] xl:max-h-[calc(100vh-96px)] xl:overflow-y-auto xl:overscroll-contain xl:pb-2">
          <AiPanel
            criteria={criteria}
            ignored={ignored}
            query={q}
            base={base}
            extra={extra}
            mode={mode}
            total={total}
            read={engineRead}
            engineTerms={engineTerms}
            kind={engineKind}
            companies={engineCompanies}
            intent={searchIntent}
            referenceProfile={referenceProfile}
            strongMatches={strongReferenceMatches}
            broaderMatches={broaderReferenceMatches}
          />

          <div className="rounded-xl border border-rule bg-surface p-4">
            {/* Keyed on the conversation: a reply's wait shows here while the old list stays, and the box starts clean when the new results land. */}
            <SearchBox
              key={q}
              vocab={[...vocab.titles, ...vocab.skills, ...vocab.industries, ...vocab.cities, ...vocab.employers]}
              prior={q}
              initialMode={mode}
              openingId={forOpening}
              referenceProfile={referenceProfile ? referenceParam : ""}
              compact
            />
            <form action={saveSearch} className="mt-3 flex items-center gap-2 border-t border-rule pt-3">
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="mode" value={mode} />
              <input type="hidden" name="count" value={total} />
              <input type="hidden" name="turns" value={JSON.stringify(turnsOf(q))} />
              {referenceProfile && <input type="hidden" name="ref" value={referenceParam} />}
              {searchIntent && <input type="hidden" name="intent" value={JSON.stringify(searchIntent)} />}
              {forOpening && <input type="hidden" name="openingId" value={forOpening} />}
              <input
                name="name"
                placeholder="Name this search to keep it"
                className="min-w-0 flex-1 rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand"
              />
              <SubmitButton
                tone="dark"
                pendingLabel="Saving…"
                className="shrink-0 rounded-full border border-brand-line px-3.5 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60"
              >
                Save
              </SubmitButton>
            </form>
          </div>
        </aside>

        <div className="order-2 min-w-0 xl:order-none">
          {refining && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-accent/20 bg-accent-soft px-4 py-3 text-[12.5px]">
              <span aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
              <p className="leading-relaxed">
                <span className="font-medium">First results — AI is still refining them.</span>
                <span className="text-ink-soft"> It is reading your search and re-ranking the closest people; this list updates on its own.</span>
              </p>
            </div>
          )}
          {retrievalProblem && (
            <p className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
              {retrievalProblem}
            </p>
          )}
          {(meaningProblem || (mode === "meaning" && !isMeaningBased())) && (
            <p className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
              {meaningProblem ?? "No embedding key is set, so \u201cby meaning\u201d is standing in with shared words. Set OPENAI_API_KEY or OPENROUTER_API_KEY for real meaning-based search."}
            </p>
          )}
          {booleanError && (
            <p className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
              {booleanError}
            </p>
          )}

          {total > 0 && (
            <section className="mb-4">
              <h2 className="mb-2.5 text-[15px] font-semibold">Spotlights</h2>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { n: free, label: "Free to approach" },
                  { n: inPipe, label: "Already being worked" },
                  { n: quick, label: "Can move in 30 days" },
                  { n: alumni, label: "Placed by us before" },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-rule bg-surface px-4 py-3.5">
                    <div className="tabular text-[21px] font-semibold leading-none">{s.n}</div>
                    <div className="mt-1.5 text-[12px] text-ink-soft">{s.label}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="overflow-hidden rounded-xl border border-rule bg-surface">
            {total > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-6 py-3">
                <span className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-soft">
                  <span className="tabular">{total.toLocaleString()}</span> {mode === "meaning" ? (total === 1 ? "relevant person" : "relevant people") : "results"}
                </span>
                {(mode === "meaning" || referenceProfile) && below > 0 && !showBelow && (
                  <Link href={broaderHref(true)} className="text-[12px] font-medium text-accent hover:underline">
                    {referenceProfile ? `Show ${below.toLocaleString()} broader ${below === 1 ? "match" : "matches"}` : `${below.toLocaleString()} more possible ${below === 1 ? "match" : "matches"} just below the bar — show ${below === 1 ? "it" : "them"}`}
                  </Link>
                )}
                {(mode === "meaning" || referenceProfile) && showBelow && (
                  <span className="text-[12px] text-ink-soft">
                    Including broader, lower-confidence matches
                    {referenceProfile && <> · <Link href={broaderHref(false)} className="font-medium text-accent hover:underline">hide them</Link></>}
                  </span>
                )}
                <span className="text-[12px] text-ink-faint">
                  {/* `scanned` counts the rows this request happens to hold,
                      which is the whole database only when the store is the
                      file. Where the engine searched, it searched all of it,
                      and quoting the working set instead would understate that
                      by about four orders of magnitude. */}
                  {engineRanked ? (
                    "searched across the whole database · ranked and explained by the matching engine"
                  ) : (
                    <>
                      from <span className="tabular">{scanned.toLocaleString()}</span> CVs ·{" "}
                      {mode === "boolean"
                        ? "matched as words across the whole CV"
                        : mode === "meaning"
                          ? "numbers and place filter outright; the rest ranked by how close the CV is to what you wrote"
                          : "numbers and place filter outright; titles and skills are scored"}
                    </>
                  )}
                </span>
              </div>
            )}

            {shown.length > 0 && (
              <div className="border-b border-rule px-6 pt-3">
                <BulkBar form="bulk-results" noun={["candidate", "candidates"]}>
                  {target?.status === "open" && (
                    <>
                      <input type="hidden" name="openingId" value={target.id} />
                      <SubmitButton
                        formAction={addManyToOpening}
                        pendingLabel="Adding…"
                        className="rounded-full bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                      >
                        Add to {target.title}
                      </SubmitButton>
                    </>
                  )}
                  <DownloadCvsButton field="candidateId" />
                </BulkBar>
              </div>
            )}

            {shown.length === 0 && filtering ? (
              <div className="px-8 py-16 text-center">
                <p className="text-[14px] font-medium">No one matches these filters</p>
                <p className="mt-2 text-[12.5px] text-ink-soft">
                  <Link href={clearFiltersHref} scroll={false} className="font-medium text-accent hover:underline">
                    Clear the filters
                  </Link>{" "}
                  to see all {everyone.length.toLocaleString()} again.
                </p>
              </div>
            ) : shown.length === 0 ? (
              <div className="px-8 py-16 text-center">
                <p className="text-[14px] font-medium">{mode === "meaning" ? "Nobody relevant found" : "Nobody matches all of that"}</p>
                {mode === "meaning" && below > 0 && (
                  <p className="mt-2 text-[12.5px] text-ink-soft">
                    <a href={`${pageHref(1)}&below=1`} className="font-medium text-accent hover:underline">
                      {below.toLocaleString()} {below === 1 ? "person is" : "people are"} just below the bar — show {below === 1 ? "them" : "them"}
                    </a>
                  </p>
                )}
                {blockers.length > 0 ? (
                  <>
                    <p className="mx-auto mt-2 max-w-[460px] text-[12.5px] leading-relaxed text-ink-soft">
                      {blockers.length === 1
                        ? "One condition is doing it. Drop it and there are people."
                        : "These are the conditions doing it. Dropping any one finds people."}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {blockers.slice(0, 5).map((b) => (
                        <Link
                          key={b.label}
                          href={b.href}
                          className="inline-flex items-center gap-1.5 rounded-full border border-rule px-3.5 py-1.5 text-[12px] transition-colors hover:border-brand-line hover:text-brand"
                        >
                          Without &ldquo;{b.label}&rdquo;
                          <span className="tabular text-[11px] text-ink-faint">{b.found}</span>
                        </Link>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mx-auto mt-2 max-w-[460px] text-[12.5px] leading-relaxed text-ink-soft">
                    No single condition explains it — it is the combination. Loosen two at a time, or
                    start from a shorter sentence.
                  </p>
                )}
              </div>
            ) : (
              shown.map((r, i) => {
                const chips = rowChips(r);
                return (
                <div key={r.candidate.id}>
                  <ResultRow
                    candidate={r.candidate}
                    fit={fit.get(r.candidate.id) ?? null}
                    hits={chips.hits}
                    misses={chips.misses}
                    intentEvidence={rowIntentEvidence(chips)}
                    roleEvidence={engineHits.get(r.candidate.id)?.roleEvidence}
                    signals={r.signals}
                    apps={appsFor(r.candidate.id)}
                    openings={openingOptions}
                    defaultOpeningId={forOpening}
                    backHref={backToResults}
                    candidateHref={candidateHref(r.candidate.id)}
                    selectForm="bulk-results"
                  />
                  {i === 1 && suggestions.length > 0 && (
                    <div className="border-b border-rule bg-paper/60 px-6 py-5">
                      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
                        <div className="shrink-0">
                          <div className="tabular text-[21px] font-semibold leading-none">
                            +{suggestions.reduce((n, s) => n + s.found, 0)}
                          </div>
                          <div className="mt-1 max-w-[150px] text-[11.5px] leading-snug text-ink-soft">
                            more people sit just outside your area
                          </div>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold">
                            Widen the area: place is a hard filter, so nobody outside{" "}
                            {criteria.locations.join(" or ")} is listed
                          </p>
                          <p className="mt-0.5 text-[12px] text-ink-soft">
                            These towns would add people to this search.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {suggestions.slice(0, 4).map((s) => (
                              <Link
                                key={s.label}
                                href={s.href}
                                className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3 py-1.5 text-[12px] transition-colors hover:border-brand-line hover:text-brand"
                              >
                                {s.label}
                                <span className="tabular text-[11px] text-ink-faint">+{s.found}</span>
                              </Link>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
              })
            )}
          </div>

          <Pager page={page} pageSize={PAGE} total={total} href={pageHref} />
        </div>

        {showFilters && (
          <aside className="order-1 flex flex-col gap-3 xl:sticky xl:top-[80px] xl:order-none xl:max-h-[calc(100vh-96px)] xl:overflow-y-auto xl:overscroll-contain xl:pb-2">
            {filtering && (
              <Link href={clearFiltersHref} scroll={false} className="rounded-xl border border-brand-line bg-brand-soft px-4 py-2 text-center text-[12.5px] font-medium text-brand hover:underline">
                Clear all filters · {results.length.toLocaleString()} of {everyone.length.toLocaleString()} shown
              </Link>
            )}
            {hasYears && (
              <ExperienceRange
                key={picked.range ? picked.range.join("-") : "any"}
                lo={picked.range?.[0] ?? 0}
                hi={picked.range?.[1] ?? EXPERIENCE_MAX}
                max={EXPERIENCE_MAX}
                base={base}
                rest={rangeRest}
                hidden={hiddenForUnknownYears(everyone, picked)}
              />
            )}
            <LevelFilter options={levelChoices} picked={pickedLevels} hrefFor={levelHref} jobTitle={target?.title ?? null} />
            {facetBlocks.map((b, i) => (
              <FacetFilter key={b.facet.param} label={b.facet.label} options={b.options} clearHref={facetClearHref(b.facet.param)} open={i === 0} />
            ))}
          </aside>
        )}
      </div>

      {activeCandidate && (
        <DbCandidateDrawer
          candidate={activeCandidate}
          apps={appsFor(activeCandidate.id)}
          openings={openingOptions}
          currentIndex={activeIndex >= 0 ? activeIndex : 0}
          totalCandidates={results.length}
          prevHref={prevCandidateId ? candidateHref(prevCandidateId) : null}
          nextHref={nextCandidateId ? candidateHref(nextCandidateId) : null}
          closeHref={closeHref}
          statusLabel={statusLabel}
          cv={activeCv}
        />
      )}
    </>
  );
}
