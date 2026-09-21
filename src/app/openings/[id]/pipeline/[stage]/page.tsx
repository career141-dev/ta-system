import { notFound } from "next/navigation";
import { allows } from "@/lib/auth";
import { AskQuestion } from "@/components/AskQuestion";
import { repo, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { seatFor } from "@/lib/visibility";
import { ProjectHeader } from "../../ProjectHeader";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { StatRow } from "@/components/StatRow";
import { PIPELINE_STAGES, CLOSED_STAGES, EARLY_STAGES, STAGE_LABEL, type Stage } from "@/data/types";
import { relDays } from "@/lib/format";
import { primeStore } from "@/data/prime";

export default async function StagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; stage: string }>;
  searchParams: Promise<ListFilters>;
}) {
  const { id, stage } = await params;
  const filters = await searchParams;
  await primeStore({ openingId: id });
  /*
   * Any real stage renders, not just the ones on the sidebar.
   *
   * The sidebar deliberately starts at Follow-up — the earlier stages are read
   * on the applicants and Database CVs screens. Every stage still has a page, so
   * nobody moved into one can become invisible with no URL that shows them.
   */
  const all = [...PIPELINE_STAGES, ...CLOSED_STAGES, ...EARLY_STAGES];
  if (!all.includes(stage as Stage)) notFound();
  const s = stage as Stage;

  const user = await getCurrentUser();

  // A stage this seat may not see is not an empty list, it is not a page. A
  // client contact typing /pipeline/rejected should get nothing, not a
  // filtered nothing that tells them the stage exists.
  const seat = seatFor(user, repo.assignmentFor(id, user.id)?.role ?? null);
  if (seat.stages !== null && !seat.stages.includes(s)) notFound();

  const everyone = repo.applications(id).filter((a) => a.stage === s);
  const apps = applyFilters(everyone, filters, user.id);
  const opening = repo.opening(id);
  if (!opening) notFound();
  const sets = setsForOpening(id);
  const oldest = [...everyone].sort((a, b) => a.lastStageChangedAt - b.lastStageChangedAt)[0];

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">{STAGE_LABEL[s]}</h1>
      <ProjectHeader openingId={id} />

      <StatRow
        items={[
          { n: everyone.length, label: "At this stage" },
          { n: sets.filter((x) => x.status === "closed").length, label: "Sets closed" },
          {
            n: oldest ? relDays(oldest.lastStageChangedAt) : "—",
            label: "Longest waiting",
          },
        ]}
      />

      {s === "follow_up" && (
        <AskQuestion
          openingId={id}
          standard={repo.followUpStandard().filter((q) => q.enabled).map((q) => q.label)}
          custom={opening.followUpQuestions.map((q) => q.label)}
          canAsk={allows(user, "opening.manage", { openingId: id, assignment: repo.assignmentFor(id, user.id) ?? null })}
        />
      )}

      <div>
        <div className="min-w-0">
          <CandidateList
            openingId={id}
            apps={apps}
            currentUser={user}
            title={STAGE_LABEL[s]}
            filters={filters}
            basePath={`/openings/${id}/pipeline/${s}`}
          />
        </div>
      </div>
    </>
  );
}
