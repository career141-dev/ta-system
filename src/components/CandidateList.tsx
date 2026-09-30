import { Fragment } from "react";
import Form from "next/form";
import { repo } from "@/data/store";
import { colomboDayLabel, colomboDayStart, groupByColomboDay } from "@/lib/calendar";
import type { Application, Candidate, User } from "@/data/types";
import { CandidateRow } from "./CandidateRow";
import { SearchIcon } from "./icons";
import { assess } from "@/lib/assessment";
import type { Score } from "@/lib/scoring";
import { seatFor, visibleToSeat } from "@/lib/visibility";
import { allows } from "@/lib/auth";
import { Pager } from "./Pager";
import { matchesQuery, pageFrom, pageLink, slicePage } from "@/lib/paging";
import { passesFilters } from "@/lib/listFilters";
import { BulkBar, BulkConfirm, DownloadCvsButton } from "./BulkSelect";
import { SubmitButton } from "./Submit";
import { confirmShortlist, removeApplications } from "@/app/actions";

const PAGE_SIZE = 25;
const BULK_FORM = "bulk-applications";

export type ListFilters = {
  q?: string;
  minExp?: string;
  maxExp?: string;
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
  /**
   * Narrow to add-ons, backups, or the rest. Absent means all of them, tagged
   * on the row: add-ons kept on a tab of their own were missed, because a TA
   * working the list forgets to look there (the desk, 28 Sep).
   */
  tag?: string;
};

/** Filtering that actually filters. Applied server-side from the URL, so a
 *  filtered view is a link a TA can bookmark or send to their lead. */
export function applyFilters(apps: Application[], f: ListFilters, userId: string) {
  return apps.filter((a) => {
    const c = repo.candidate(a.candidateId);
    if (!c) return false;
    if (f.q && !matchesQuery(f.q, c.fullName, c.currentTitle, c.currentEmployer, c.location)) return false;
    if (f.mine === "1" && a.ownerTaId !== userId) return false;
    if (f.tag === "addon" && !a.isAddOn) return false;
    if (f.tag === "backup" && !a.backupForApplicationId) return false;
    if (f.tag === "standard" && (a.isAddOn || a.backupForApplicationId)) return false;
    return passesFilters(c, f);
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
  groupByDay,
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
  /**
   * Split the list into days — Today, Yesterday, then dates — on this
   * timestamp, newest first. Director review uses it so each day's batch reads
   * on its own (30 Sep).
   */
  groupByDay?: (a: Application) => number;
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
  const canManage = allows(currentUser, "opening.manage", { openingId, assignment });
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
  } else if (groupByDay) {
    shown = groupByColomboDay(shown, groupByDay).flatMap((d) => d.items);
  }
  // Days first, whatever the order inside them: sorted by fit alone — the
  // default wherever there are scores — the day headings came back scattered
  // (Today, Yesterday, Today…). Each day keeps the chosen order (review, 30 Sep).
  if (groupByDay && (sort === "worst" || (ranked && sort === "fit"))) {
    const days = new Map<number, Application[]>();
    for (const a of shown) {
      const d = colomboDayStart(groupByDay(a));
      days.set(d, [...(days.get(d) ?? []), a]);
    }
    shown = [...days].sort((x, y) => y[0] - x[0]).flatMap(([, list]) => list);
  }
  // Each day's count is the whole day's, not just what is on this page.
  const dayCount = new Map<number, number>();
  if (groupByDay) {
    for (const a of shown) {
      const day = colomboDayStart(groupByDay(a));
      dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
    }
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
      {/* next/form: Apply updates the list in place instead of reloading the
          whole page — header, rail and matching banner included (28 Sep). */}
      <Form
        action={basePath}
        className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-rule px-8 py-5"
      >
        {Object.entries(keepQuery).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {/* And the rail's fields, for the same reason — see FilterPanel. */}
        {(["location", "maxExp", "company", "past", "skill", "school", "industry", "title", "nationality"] as const).map(
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
        <div className="relative">
          <select
            name="tag"
            defaultValue={filters.tag ?? ""}
            aria-label="Add-ons and backups"
            className="cursor-pointer appearance-none rounded-full border border-rule bg-surface py-2 pl-3.5 pr-9 text-[12.5px] text-ink-soft outline-none transition-colors focus:border-brand"
          >
            <option value="">All candidates</option>
            <option value="addon">Add-ons only</option>
            <option value="backup">Backups only</option>
            <option value="standard">Neither</option>
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
      </Form>


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
          <div className="px-8 pt-4">
            <BulkBar form={BULK_FORM} noun={["candidate", "candidates"]} action={canManage ? removeApplications : undefined}>
              <input type="hidden" name="openingId" value={openingId} />
              {claimable && (
                <SubmitButton
                  formAction={confirmShortlist}
                  pendingLabel="Shortlisting…"
                  className="rounded-full bg-brand px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  Shortlist selected
                </SubmitButton>
              )}
              <DownloadCvsButton field="appId" />
              {canManage && (
                <BulkConfirm
                  label="Remove from this job"
                  noun={["candidate", "candidates"]}
                  warning="They move to Dropped out and can be brought back from there."
                />
              )}
            </BulkBar>
          </div>
          {onPage.map((a, i) => {
            const c = repo.candidate(a.candidateId);
            if (!c) return null;
            const owner = users.find((u) => u.id === a.ownerTaId);
            // Locked for anyone the collision lock applies to — the same test the
            // server makes, so the screen never offers what will be refused.
            const locked = !allows(currentUser, "opening.act", { openingId, assignment, ownerTaId: a.ownerTaId });
            // A day heading before each day's first row, and again at the top of
            // a page that carries a day on, so no page starts without one.
            const day = groupByDay ? colomboDayStart(groupByDay(a)) : null;
            const prev = groupByDay && i > 0 ? colomboDayStart(groupByDay(onPage[i - 1])) : null;
            const n = day !== null ? (dayCount.get(day) ?? 0) : 0;
            return (
              <Fragment key={a.id}>
              {day !== null && day !== prev && (
                <div className="bg-paper px-8 py-2.5 text-[12px] font-medium text-ink-soft">
                  {colomboDayLabel(day)}
                  <span className="font-normal text-ink-faint">
                    {" "}· {n} {n === 1 ? "candidate" : "candidates"}
                  </span>
                </div>
              )}
              <CandidateRow
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
                selectForm={BULK_FORM}
              />
              </Fragment>
            );
          })}
        </div>
      )}
      <Pager page={page} pageSize={PAGE_SIZE} total={shown.length} href={pageLink(basePath, linkParams)} className="border-t border-rule py-4" />
    </section>
  );
}
