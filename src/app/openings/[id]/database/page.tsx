import { repo } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { ProjectHeader } from "../ProjectHeader";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { FilterPanel, type FilterOptions } from "@/components/FilterPanel";
import { StatRow } from "@/components/StatRow";
import Link from "next/link";
import { allows } from "@/lib/auth";
import { primeStore } from "@/data/prime";
import { requireSourcingSeat } from "../sourcingGate";
import { isConvex } from "@/data/mode";
import * as backend from "@/data/convex/backend";
import { MatchingStatus } from "@/components/MatchingStatus";
import { linkedCandidates } from "@/lib/dbMatch";

export default async function DatabasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ListFilters>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  const user = await getCurrentUser();
  // Someone also on this opening's Excel Tables lives there, not here twice.
  const inTables = linkedCandidates(id);
  const everyone = repo
    .applications(id)
    // Database picks not yet shortlisted. Every database pick is saved as
    // SCOOP, so filtering on the channel kept people here after they had moved
    // on — each showing an "In director shortlist" box on a search screen
    // (testing, 21 Sep). Once shortlisted they belong to the pipeline pages.
    .filter((a) => a.stage === "matched" || (a.sourcingChannel === "SCOOP" && a.stage === "new_cv"))
    .filter((a) => !inTables.has(a.candidateId));
  const apps = applyFilters(everyone, filters, user.id);
  const unclaimed = everyone.filter((a) => !a.ownerTaId).length;
  // A starting sentence for the database search. Only the title — an opening's
  // `locations` are often countries ("Sri Lanka, Bangladesh") and the parser
  // matches cities, so passing them through would put real words in the
  // "not acted on" list and read as a failure.
  const searchSeed = repo.opening(id)?.title ?? "";
  const opening = repo.opening(id);
  // The whole database, from the backend's counter — the in-memory store holds
  // only the people this page loaded, so its length was a meaningless number.
  // (The Automatic matches box and its last-run line were removed in the desk
  // review, so neither `lastRun` nor `canRun` is needed here any more.)
  const databaseTotal = isConvex()
    ? await backend.candidateStats({ id: null }).then((s) => `${s.total.toLocaleString()}${s.sampled ? "+" : ""}`).catch(() => "—")
    : repo.candidates().length.toLocaleString();

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
          { n: databaseTotal, label: "In the whole database" },
        ]}
      />

      <div className="mb-6">
        <MatchingStatus openingId={id} full={everyone.length === 0} />
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
