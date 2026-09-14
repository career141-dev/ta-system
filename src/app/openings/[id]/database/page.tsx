import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { ProjectHeader } from "../ProjectHeader";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { FilterPanel, type FilterOptions } from "@/components/FilterPanel";
import { StatRow } from "@/components/StatRow";
import Link from "next/link";
import { findMatchesNow } from "@/app/actions";
import { allows } from "@/lib/auth";
import { isMeaningBased } from "@/lib/embed";
import { dateAt } from "@/lib/format";
import { LIMITS } from "@/lib/dbMatch";

export default async function DatabasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ListFilters>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const user = await getCurrentUser();
  const everyone = repo
    .applications(id)
    .filter((a) => a.stage === "matched" || a.sourcingChannel === "SCOOP");
  const apps = applyFilters(everyone, filters, user.id);
  const unclaimed = everyone.filter((a) => !a.ownerTaId).length;
  // A starting sentence for the database search. Only the title — an opening's
  // `locations` are often countries ("Sri Lanka, Bangladesh") and the parser
  // matches cities, so passing them through would put real words in the
  // "not acted on" list and read as a failure.
  const searchSeed = repo.opening(id)?.title ?? "";
  const opening = repo.opening(id);
  const lastRun = repo.matchRuns(id)[0] ?? null;
  const canRun = allows(user, "opening.sourcing", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null });

  // The filter rail offers what this list actually contains, not the whole
  // database — an option that cannot match anything on screen is noise.
  const inScope = everyone
    .map((a) => repo.candidate(a.candidateId))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  const uniq = (xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter(Boolean) as string[])].sort();
  const options: FilterOptions = {
    companies: uniq(inScope.map((c) => c.currentEmployer)),
    past: uniq(inScope.flatMap((c) => c.workHistory.map((w) => w.employer))),
    skills: uniq(inScope.flatMap((c) => c.skills)),
    schools: uniq(inScope.map((c) => c.educationInstitution)),
    industries: uniq(inScope.flatMap((c) => c.industries)),
    titles: uniq(inScope.map((c) => c.currentTitle)),
    nationalities: uniq(inScope.map((c) => c.nationality)),
  };

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[21px] font-semibold tracking-tight">Database CVs</h1>
          <ProjectHeader openingId={id} />
        </div>
        <Link
          href={`/database/results?for=${id}&q=${encodeURIComponent(searchSeed)}`}
          className="shrink-0 rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft"
        >
          Search the whole database
        </Link>
      </div>

      <StatRow
        items={[
          { n: everyone.length, label: "Matched to this opening" },
          { n: unclaimed, label: "Nobody has claimed" },
          { n: repo.candidates().length.toLocaleString(), label: "In the database" },
        ]}
      />

      {/* The automatic search: nearest by meaning, hard rules, fit score, model
          review — the best waiting here for a TA. Runs on JD approval and nightly. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-rule bg-surface px-5 py-3.5 text-[12.5px]">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Automatic matches</p>
          <p className="mt-0.5 text-ink-soft">
            {opening?.jdStatus !== "approved"
              ? "Start once the JD is approved, then run every night."
              : lastRun
                ? `Last run ${dateAt(lastRun.at)}: ${lastRun.considered} nearest ${isMeaningBased() ? "by meaning" : "by shared words"}, ${lastRun.afterRules} passed nationality, location and experience, ${lastRun.added} added.`
                : "Not run yet. Runs every night; up to " + LIMITS.shown + " wait here at a time."}
            {lastRun?.note && <span className="text-ink-faint"> {lastRun.note}</span>}
          </p>
        </div>
        {canRun && opening?.jdStatus === "approved" && (
          <form action={findMatchesNow}>
            <input type="hidden" name="openingId" value={id} />
            <button className="rounded-full border border-brand-line px-4 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-soft">
              Find matches now
            </button>
          </form>
        )}
      </div>

      <div className="flex gap-9">
        <FilterPanel
          total={everyone.length}
          shown={apps.length}
          basePath={`/openings/${id}/database`}
          filters={filters}
          options={options}
        />
        <div className="min-w-0 flex-1">
          <CandidateList
            scored
            openingId={id}
            apps={apps}
            currentUser={user}
            title="Database"
            filters={filters}
            claimable
            basePath={`/openings/${id}/database`}
          />
        </div>
      </div>
    </>
  );
}
