import { repo } from "@/data/store";
import type { Application, Candidate, User } from "@/data/types";
import { CandidateRow } from "./CandidateRow";
import { SearchIcon } from "./icons";
import { assess } from "@/lib/assessment";
import type { Score } from "@/lib/scoring";
import { seatFor, visibleToSeat } from "@/lib/visibility";
import { allows } from "@/lib/auth";
import { confirmShortlist } from "@/app/actions";
import { Pager } from "./Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";

const PAGE_SIZE = 25;

export type ListFilters = {
  q?: string;
  minExp?: string;
  maxNotice?: string;
  location?: string;
  mine?: string;
  /** The groups §11 says the database can serve. All of them read fields the
   *  candidate record already carries — including work history, which is what
   *  "past companies" means. */
  company?: string;
  past?: string;
  skill?: string;
  school?: string;
  industry?: string;
  title?: string;
  nationality?: string;
  /** How the list is ordered. Defaults to fit where the JD is approved. */
  sort?: string;
  /** A message carried in from an action, so a refusal is visible. */
  msg?: string;
  /** Only show one band — "the strong ones", which is the first cut a TA makes. */
  band?: string;
  /** Which page of the list — 25 to a page. */
  page?: string;
};

/** Filtering that actually filters. Applied server-side from the URL, so a
 *  filtered view is a link a TA can bookmark or send to their lead. */
export function applyFilters(apps: Application[], f: ListFilters, userId: string) {
  return apps.filter((a) => {
    const c = repo.candidate(a.candidateId);
    if (!c) return false;
    if (f.q && !matchesQuery(f.q, c.fullName, c.currentTitle, c.currentEmployer, c.location)) return false;
    if (f.minExp && (c.totalExperienceYears ?? 0) < Number(f.minExp)) return false;
    if (f.maxNotice && (c.noticePeriodDays ?? 999) > Number(f.maxNotice)) return false;
    if (f.location && c.location !== f.location) return false;
    if (f.mine === "1" && a.ownerTaId !== userId) return false;

    // Substring and case-insensitive: a TA types "cargills", not the registered
    // name, and a filter that only matches an exact string is a filter nobody
    // uses twice.
    const has = (hay: string | null | undefined, needle?: string) =>
      !needle || (hay ?? "").toLowerCase().includes(needle.toLowerCase());
    const hasAny = (hay: string[], needle?: string) =>
      !needle || hay.some((x) => x.toLowerCase().includes(needle.toLowerCase()));

    if (!has(c.currentEmployer, f.company)) return false;
    if (!has(c.currentTitle, f.title)) return false;
    if (!has(c.educationInstitution, f.school)) return false;
    if (!has(c.nationality, f.nationality)) return false;
    if (!hasAny(c.skills, f.skill)) return false;
    if (!hasAny(c.industries, f.industry)) return false;
    if (!hasAny(c.workHistory.map((w) => w.employer), f.past)) return false;
    return true;
  });
}

export function CandidateList({
  openingId,
  apps: given,
  currentUser,
  title,
  filters = {},
  claimable = false,
  /**
   * Whether to score and rank.
   *
   * On the sourcing screens — Database CVs and the job's applicants — the
   * score is the whole point: it is what saves reading a hundred CVs. On the
   * pipeline it is noise. Everybody there has already been read and chosen by
   * a person, and putting a number beside a candidate a TA has personally
   * shortlisted second-guesses a decision that has already been made.
   */
  scored: showScore = false,
  basePath,
  keepQuery = {},
}: {
  openingId: string;
  apps: Application[];
  currentUser: User;
  title: string;
  filters?: ListFilters;
  claimable?: boolean;
  scored?: boolean;
  basePath: string;
  /** Query the filter form must carry through — the post being viewed, say. */
  keepQuery?: Record<string, string>;
}) {
  const users = repo.users();

  /*
   * The seat filter, applied at the one place every candidate list passes
   * through.
   *
   * `visibleToSeat` existed and was called by nothing — so a client contact got
   * a sidebar with the sourcing screens hidden and a pipeline list that still
   * showed them everybody, rejected candidates included. Hiding the menu is not
   * access control; filtering the rows is.
   */
  const assignment = repo.assignmentFor(openingId, currentUser.id) ?? null;
  const seat = seatFor(currentUser, assignment?.role ?? null);
  const canDecideDirector = allows(currentUser, "decide.director", { openingId, assignment });
  const canDecideClient = allows(currentUser, "decide.client", { openingId, assignment });
  const apps = visibleToSeat(given, seat);

  const active = Object.entries(filters).filter(([k, v]) => v && k !== "page" && k !== "msg");
  const keep = new URLSearchParams(keepQuery).toString();
  const clearHref = keep ? `${basePath}?${keep}` : basePath;

  /*
   * Score the whole list in one go.
   *
   * `scoreSet` rather than a loop of `scoreCandidate` on purpose: it decides
   * ONCE, for the set, whether semantic recall is folded in — either everybody
   * gets it or nobody does. Scoring people one at a time produces numbers that
   * cannot be compared with each other, which is the one thing a ranked list
   * must not do.
   *
   * Nothing is scored before the JD is approved. Until then there are no
   * agreed requirements, and a number with nothing behind it is worse than no
   * number.
   */
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  const scored: Map<string, Score> = new Map();

  const assessment = showScore && opening
    ? assess(opening.id, apps.map((a) => repo.candidate(a.candidateId)).filter((c): c is Candidate => !!c))
    : null;
  if (assessment?.ok) {
    for (const a of apps) {
      const hit = assessment.scores.get(a.candidateId);
      if (hit) scored.set(a.id, hit);
    }
  }

  const value = (id: string): number | undefined => scored.get(id)?.overall;

  const ranked = scored.size > 0;
  const sort = filters.sort ?? (ranked ? "fit" : "recent");

  let shown = apps;
  if (ranked && filters.band) {
    shown = shown.filter((a) => scored.get(a.id)?.band === filters.band);
  }
  if (ranked && sort === "fit") {
    shown = [...shown].sort((a, b) => (value(b.id) ?? -1) - (value(a.id) ?? -1));
  } else if (sort === "worst") {
    shown = [...shown].sort((a, b) => (value(a.id) ?? 999) - (value(b.id) ?? 999));
  }

  // Rank is against the whole scored list, so it does not renumber when a band
  // filter is on — "#3 of the lot" is more use than "#1 of the three I filtered".
  const order = [...apps].sort((a, b) => (value(b.id) ?? -1) - (value(a.id) ?? -1));
  const rankOf = (id: string) => order.findIndex((a) => a.id === id) + 1;

  // One page of the list at a time. A page link keeps the post being viewed,
  // the search and every filter, and changes only the page.
  const linkParams: Record<string, string> = { ...keepQuery };
  for (const [k, v] of Object.entries(filters)) if (typeof v === "string" && v) linkParams[k] = v;
  const page = pageFrom(filters, shown.length, PAGE_SIZE);
  const onPage = slicePage(shown, page, PAGE_SIZE);

  return (
    <section className="rounded-xl border border-rule bg-surface">
      <form
        method="GET"
        action={basePath}
        className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-rule px-8 py-5"
      >
        {Object.entries(keepQuery).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {/* And the rail's fields, for the same reason — see FilterPanel. */}
        {(["location", "company", "past", "skill", "school", "industry", "title", "nationality"] as const).map(
          (k) => (filters[k] ? <input key={k} type="hidden" name={k} value={filters[k]} /> : null),
        )}
        <label className="relative min-w-[240px] flex-1 max-w-[320px]">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint">
            <SearchIcon />
          </span>
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Search by name, title or company"
            className="w-full rounded-full border border-rule bg-surface py-2 pl-9 pr-4 text-[13px] outline-none placeholder:text-ink-faint focus:border-brand-line"
          />
        </label>
        <div className="relative">
          <select
            name="minExp"
            defaultValue={filters.minExp ?? ""}
            className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-2 pl-3.5 pr-9 text-[12.5px] text-ink-soft outline-none transition-colors focus:border-brand"
          >
            <option value="">Any experience</option>
            <option value="5">5+ years</option>
            <option value="10">10+ years</option>
            <option value="15">15+ years</option>
          </select>
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <div className="relative">
          <select
            name="maxNotice"
            defaultValue={filters.maxNotice ?? ""}
            className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-2 pl-3.5 pr-9 text-[12.5px] text-ink-soft outline-none transition-colors focus:border-brand"
          >
            <option value="">Any notice</option>
            <option value="30">30 days or less</option>
            <option value="60">60 days or less</option>
          </select>
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        {ranked && (
          <>
            <div className="relative">
              <select
                name="sort"
                defaultValue={sort}
                className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-2 pl-3.5 pr-9 text-[12.5px] text-ink-soft outline-none transition-colors focus:border-brand"
              >
                <option value="fit">Best fit first</option>
                <option value="worst">Weakest first</option>
                <option value="recent">Pipeline order</option>
              </select>
              <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <div className="relative">
              <select
                name="band"
                defaultValue={filters.band ?? ""}
                className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-2 pl-3.5 pr-9 text-[12.5px] text-ink-soft outline-none transition-colors focus:border-brand"
              >
                <option value="">Any fit</option>
                <option value="strong">Strong only</option>
                <option value="worth a look">Worth a look</option>
                <option value="weak">Weak only</option>
              </select>
              <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
          </>
        )}
        <button className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand hover:bg-brand-soft">
          Apply
        </button>
        {active.length > 0 && (
          <a href={clearHref} className="text-[12.5px] text-ink-soft hover:text-ink">
            Clear
          </a>
        )}
        <span className="ml-auto text-[12.5px] text-ink-faint">
          {shown.length === apps.length
            ? `${apps.length} in ${title.toLowerCase()}`
            : `${shown.length} of ${apps.length} in ${title.toLowerCase()}`}
          {ranked && (
            <span className="text-ink-faint">
              {" "}· scored against the approved JD
            </span>
          )}
          {assessment && !assessment.ok && (
            <span className="text-ink-faint"> · {assessment.message}</span>
          )}
        </span>
      </form>

      {/*
        High scorers are pre-shortlisted and the TA confirms them in one click
        (13 September). Nothing moves until they press it: the AI call starts
        the moment somebody is in Follow-up, so a person decides who that is.
      */}
      {(() => {
        if (!claimable || !ranked) return null;
        const bar = Number(repo.setting("autoShortlistScore", "75")) || 75;
        const suggested = order.filter((a) => {
          const sc = value(a.id);
          return (
            sc !== undefined && sc >= bar && !a.ownerTaId && (a.stage === "new_cv" || a.stage === "matched") &&
            allows(currentUser, "opening.act", { openingId, assignment, ownerTaId: a.ownerTaId })
          );
        });
        if (suggested.length === 0) return null;
        return (
          <form action={confirmShortlist} className="border-b border-rule bg-brand-soft/40 px-8 py-4">
            <input type="hidden" name="openingId" value={openingId} />
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-[13px] font-medium">
                {suggested.length} scored {bar} or more — shortlisted for you, waiting on your confirm
              </p>
              <button className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90">
                Confirm shortlist
              </button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
              {suggested.map((a) => {
                const c = repo.candidate(a.candidateId);
                return (
                  <label key={a.id} className="flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" name="appId" value={a.id} defaultChecked />
                    <span>{c?.fullName}</span>
                    <span className="tabular text-ink-faint">{value(a.id)}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Untick anyone you do not want. Confirming sends them to Follow-up, where the AI call goes first.
            </p>
          </form>
        );
      })()}

      {shown.length === 0 ? (
        <div className="px-8 py-20 text-center">
          <p className="text-[13.5px] text-ink-soft">Nobody here.</p>
          <p className="mt-1.5 text-[12.5px] text-ink-faint">
            {active.length > 0
              ? "No one matches those filters — try clearing them."
              : "Candidates arrive here as they move through the pipeline."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-rule">
          {onPage.map((a) => {
            const c = repo.candidate(a.candidateId);
            if (!c) return null;
            const owner = users.find((u) => u.id === a.ownerTaId);
            // Locked for anyone the collision lock applies to — the same test the
            // server makes, so the screen never offers what will be refused.
            const locked = !allows(currentUser, "opening.act", { openingId, assignment, ownerTaId: a.ownerTaId });
            return (
              <CandidateRow
                key={a.id}
                app={a}
                candidate={c}
                owner={owner}
                locked={locked}
                claimable={claimable && !a.ownerTaId}
                openingId={openingId}
                score={scored.get(a.id)}
                rank={scored.has(a.id) ? rankOf(a.id) : undefined}
                canDecideDirector={canDecideDirector}
                canDecideClient={canDecideClient}
              />
            );
          })}
        </div>
      )}
      <Pager page={page} pageSize={PAGE_SIZE} total={shown.length} href={pageLink(basePath, linkParams)} className="border-t border-rule py-4" />
    </section>
  );
}
