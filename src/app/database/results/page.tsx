import Link from "next/link";
import { repo } from "@/data/store";
import { assess } from "@/lib/assessment";
import type { Score } from "@/lib/scoring";
import { pageUser } from "@/lib/session";
import { STAGE_LABEL } from "@/data/types";
import { criteriaFromParams, criteriaToParams, describe, parseBoolean, parseQuery, withoutChip, withValue } from "@/lib/query";
import { SearchBox } from "@/components/db/SearchBox";
import { AiPanel } from "@/components/db/AiPanel";
import { ResultRow, type RowApp } from "@/components/db/ResultRow";
import { saveSearch } from "@/app/actions";
import { BELOW_BAR, RELEVANT_SIMILARITY, embedQuery, isMeaningBased, nearestCandidates } from "@/lib/embed";
import { refreshCandidateVectors } from "@/lib/dbMatch";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { keywordRetrieve } from "@/lib/retrieve";

const PAGE = 25;

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  await primeStore({ allApplications: true });
  await pageUser("database.read");
  const q = typeof sp.q === "string" ? sp.q : "";
  const mode = sp.mode === "boolean" ? "boolean" : sp.mode === "meaning" ? "meaning" : "natural";
  const forOpening = typeof sp.for === "string" ? sp.for : null;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const vocab = repo.vocabulary();

  // The sentence is parsed once; after that the URL's criteria win, so removing
  // a chip actually removes it rather than being re-derived from the text.
  const edited =
    (sp as Record<string, string | undefined>).edited === "1" ||
    criteriaToParams(criteriaFromParams(sp)).toString().length > 0;
  // By meaning still reads the sentence for the strict parts — place, years,
  // notice, salary — and lets the similarity rank everything else.
  const parsed = mode !== "boolean" ? parseQuery(q, vocab) : null;
  const criteria = edited ? criteriaFromParams(sp) : (parsed?.criteria ?? criteriaFromParams(sp));
  const ignored = edited ? [] : (parsed?.ignored ?? []);
  const booleanError = mode === "boolean" ? parseBoolean(q).error : null;

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
   * So the words are put to the backend's own full-text indexes first — title,
   * skills, summary and CV text — and whoever comes back is brought into the
   * working set for the criteria to narrow. No model and no key involved;
   * this is the route that still works when the meaning half cannot run.
   */
  if (isConvex() && q && mode !== "meaning") {
    try {
      const terms = [
        q,
        ...criteria.titles,
        ...criteria.skills.slice(0, 3),
        ...criteria.employers.slice(0, 2),
        ...criteria.qualifications.slice(0, 2),
      ];
      const hits = await keywordRetrieve(terms, 150);
      await primeStore({ candidateIds: hits });
      if (hits.length === 0) retrievalProblem = "Nothing in the database matched those words.";
    } catch (e) {
      retrievalProblem = `The database could not be searched (${(e as Error).message}).`;
    }
  }

  if (mode === "meaning" && q) {
    const vectors = await refreshCandidateVectors();
    const query = vectors.ok ? await embedQuery(q) : vectors;
    if (query.ok) {
      // Bounded, not the whole index. Asking for every vector's similarity was
      // affordable against a file of 755; against 77,000 in Qdrant it is a
      // request for the entire database. The page shows 25 at a time and the
      // spotlight counts describe the matches, so a deep-but-finite list is
      // the same answer for far less work.
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
          const hits = await keywordRetrieve([q, ...criteria.titles], 150);
          await primeStore({ candidateIds: hits });
        } catch (e) {
          retrievalProblem = `The database could not be searched (${(e as Error).message}).`;
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
  const bar = isMeaningBased() ? RELEVANT_SIMILARITY : Math.max(0.08, best * 0.6);
  const floor = showBelow ? bar - (isMeaningBased() ? BELOW_BAR : 0.04) : bar;
  const { results, total, scanned, below } = repo.searchDatabase(criteria, {
    boolean: mode === "boolean" ? q : null,
    limit: Number.MAX_SAFE_INTEGER,
    similarity,
    floor,
    belowFloor: showBelow ? undefined : bar - (isMeaningBased() ? BELOW_BAR : 0.04),
  });
  const shown = results.slice((page - 1) * PAGE, page * PAGE);

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
  const assessment = target ? assess(target.id, shown.map((r) => r.candidate)) : null;
  if (assessment?.ok) for (const [id, score] of assessment.scores) fit.set(id, score);

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
  };

  // Widening — only offered where it would actually find someone.
  const suggestions: { label: string; found: number; href: string }[] = [];
  if (criteria.locations.length) {
    for (const city of vocab.cities.filter((c) => !criteria.locations.includes(c))) {
      const widened = { ...criteria, locations: [...criteria.locations, city] };
      const found = repo.searchDatabase(widened, { boolean: mode === "boolean" ? q : null, limit: 1, similarity, floor }).total - total;
      if (found > 0) suggestions.push({ label: city, found, href: `${base}${withValue(criteria, "locations", city, extra)}` });
    }
    suggestions.sort((a, b) => b.found - a.found);
  }

  // When nothing comes back, name the condition responsible rather than telling
  // the TA to guess at it.
  const blockers: { label: string; found: number; href: string }[] = [];
  if (total === 0 && mode !== "boolean") {
    for (const chip of describe(criteria)) {
      const relaxed = criteriaFromParams(
        Object.fromEntries(new URLSearchParams(withoutChip(criteria, chip).slice(1))),
      );
      const found = repo.searchDatabase(relaxed, { limit: 1, similarity, floor }).total;
      if (found > 0) blockers.push({ label: chip.label, found, href: `${base}${withoutChip(criteria, chip, extra)}` });
    }
    blockers.sort((a, b) => b.found - a.found);
  }

  const pageHref = (n: number) => {
    const p = criteriaToParams(criteria);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    p.set("page", String(n));
    if (edited) p.set("edited", "1");
    return `${base}?${p.toString()}`;
  };

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
      };
    });

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

      <div className="grid items-start gap-6 xl:grid-cols-[400px_1fr]">
        <aside className="flex flex-col gap-3 xl:sticky xl:top-[80px]">
          <AiPanel
            criteria={criteria}
            ignored={ignored}
            query={q}
            base={base}
            extra={extra}
            mode={mode}
            total={total}
          />

          <div className="rounded-xl border border-rule bg-surface p-4">
            <SearchBox
              vocab={[...vocab.titles, ...vocab.skills, ...vocab.industries, ...vocab.cities, ...vocab.employers]}
              initialQuery={q}
              initialMode={mode}
              openingId={forOpening}
              compact
            />
            <form action={saveSearch} className="mt-3 flex items-center gap-2 border-t border-rule pt-3">
              <input type="hidden" name="q" value={q} />
              <input type="hidden" name="mode" value={mode} />
              <input type="hidden" name="count" value={total} />
              {forOpening && <input type="hidden" name="openingId" value={forOpening} />}
              <input
                name="name"
                placeholder="Name this search to keep it"
                className="min-w-0 flex-1 rounded-lg border border-rule bg-surface px-3 py-1.5 text-[12px] outline-none transition-colors placeholder:text-ink-faint/70 focus:border-brand"
              />
              <button className="shrink-0 rounded-full border border-brand-line px-3.5 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft">
                Save
              </button>
            </form>
          </div>
        </aside>

        <div className="min-w-0">
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
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                {mode === "meaning" && below > 0 && (
                  <a href={`${pageHref(1)}&below=1`} className="text-[12px] font-medium text-accent hover:underline">
                    {below.toLocaleString()} more possible {below === 1 ? "match" : "matches"} just below the bar — show {below === 1 ? "it" : "them"}
                  </a>
                )}
                {mode === "meaning" && showBelow && (
                  <span className="text-[12px] text-ink-soft">Including people just below the relevance bar</span>
                )}
                <span className="text-[12px] text-ink-faint">
                  from <span className="tabular">{scanned.toLocaleString()}</span> CVs ·{" "}
                  {mode === "boolean"
                    ? "matched as words across the whole CV"
                    : mode === "meaning"
                      ? "numbers and place filter outright; the rest ranked by how close the CV is to what you wrote"
                      : "numbers and place filter outright; titles and skills are scored"}
                </span>
              </div>
            )}

            {shown.length === 0 ? (
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
              shown.map((r, i) => (
                <div key={r.candidate.id}>
                  <ResultRow
                    candidate={r.candidate}
                    fit={fit.get(r.candidate.id) ?? null}
                    hits={r.hits}
                    misses={r.misses}
                    signals={r.signals}
                    apps={appsFor(r.candidate.id)}
                    openings={openingOptions}
                    defaultOpeningId={forOpening}
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
              ))
            )}
          </div>

          {total > PAGE && (
            <div className="mt-5 flex items-center justify-center gap-3 text-[12.5px]">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Previous</Link>
              ) : (
                <span className="rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Previous</span>
              )}
              <span className="tabular text-ink-soft">Page {page} of {Math.ceil(total / PAGE)}</span>
              {page * PAGE < total ? (
                <Link href={pageHref(page + 1)} className="rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Next</Link>
              ) : (
                <span className="rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Next</span>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
