import { notFound, redirect } from "next/navigation";
import { allows } from "@/lib/auth";
import { AskQuestion } from "@/components/AskQuestion";
import { SubmitButton } from "@/components/SubmitButton";
import { SubmitButton as Submit } from "@/components/Submit";
import { setOpeningAutoFollowUp, setOpeningQuestions } from "@/app/actions";
import { repo, setsForOpening } from "@/data/store";
import { getCurrentUser } from "@/lib/session";
import { seatFor, visibleToSeat } from "@/lib/visibility";
import { ProjectHeader } from "../../ProjectHeader";
import { CandidateList, applyFilters, type ListFilters } from "@/components/CandidateList";
import { StatRow } from "@/components/StatRow";
import { HhUpload } from "@/components/HhUpload";
import { PIPELINE_STAGES, CLOSED_STAGES, EARLY_STAGES, STAGE_LABEL, type Stage } from "@/data/types";
import { relDays } from "@/lib/format";
import { primeStore } from "@/data/prime";
import { ProblemState } from "@/components/ProblemState";
import { workLocationView, inWorkLocation } from "@/lib/workLocations";
import { WorkLocationTabs } from "@/components/WorkLocationTabs";

export default async function StagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; stage: string }>;
  searchParams: Promise<ListFilters>;
}) {
  const { id, stage } = await params;
  if (stage === "follow_up") {
    redirect(`/openings/${id}/pipeline/ta_follow_up`);
  }
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
  const assignment = repo.assignmentFor(id, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(id).some((r) => r.doneBy.includes(user.id));
  const seat = seatFor(user, assignment?.role ?? null, onStrategy);
  if (seat.stages !== null && !seat.stages.includes(s)) {
    return (
      <ProblemState
        title="This stage is unavailable"
        message="Your role does not include this part of the pipeline. Return to the opening and choose an available stage."
        primaryHref={`/openings/${id}`}
        primaryLabel="Go to opening"
      />
    );
  }

  // A TA's stage page is their own candidates and the unclaimed ones; the
  // other TA's are not on it. A lead's shows both (2 Oct).
  const opening = repo.opening(id);
  if (!opening) notFound();
  const workLocationId = workLocationView(opening, filters.workLocation);
  const everyone = visibleToSeat(repo.applications(id), seat).filter((a) => a.stage === s && inWorkLocation(a, workLocationId));
  const apps = applyFilters(everyone, filters, user.id);
  // Each TA numbers their own sets, so a TA sees theirs; a lead sees both.
  const sets = setsForOpening(id, seat.ownDeskOf ?? undefined);
  const oldest = [...everyone].sort((a, b) => a.lastStageChangedAt - b.lastStageChangedAt)[0];
  const canManage = allows(user, "opening.manage", { openingId: id, assignment, onStrategy });
  // Whoever works this opening can bring in a headhunted CV (the upload route
  // checks the same rule).
  const canAct = allows(user, "opening.act", { openingId: id, assignment, onStrategy });

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">{STAGE_LABEL[s]}</h1>
      <ProjectHeader openingId={id} />
      <WorkLocationTabs locations={opening.workLocations} selected={workLocationId} basePath={`/openings/${id}/pipeline/${s}`} paramKey="workLocation" />

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

      {/* On both follow-up pages: TA Follow-up is where the reminders this
          switch controls go out (PR #32), so it cannot live only on AI
          Follow-up (review of PR #31, 24 Sep). */}
      {(s === "ai_follow_up" || s === "ta_follow_up") && (
        <div className="mb-6 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-2">
          {/* Automatic follow-up: reminders after the TA's first Send. */}
          <div className="rounded-xl border border-rule bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] font-medium text-ink">
                Automatic follow-up
                <span className={`ml-1.5 font-normal ${opening.autoFollowUp ? "text-brand" : "text-ink-faint"}`}>
                  · {opening.autoFollowUp ? "on" : "off"}
                </span>
              </span>
              {canManage && (
                <form action={setOpeningAutoFollowUp}>
                  <input type="hidden" name="openingId" value={id} />
                  <input type="hidden" name="enabled" value={opening.autoFollowUp ? "off" : "on"} />
                  <Submit
                    tone="dark"
                    pendingLabel={opening.autoFollowUp ? "Turning off…" : "Turning on…"}
                    className="rounded-full border border-rule px-3 py-1 text-[11.5px] font-medium hover:bg-tag disabled:opacity-60"
                  >
                    {opening.autoFollowUp ? "Turn off" : "Turn on"}
                  </Submit>
                </form>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              {opening.autoFollowUp
                ? "After you send a candidate the first follow-up, WhatsApp and email reminders go out every 24 hours until the details are in or the reminders run out."
                : "Follow-ups go out only when you press Send on a candidate."}
            </p>
          </div>

          {/* The TA's own follow-up questions for this job. */}
          <details className="group rounded-xl border border-rule bg-surface p-4">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-medium text-ink">
                  Follow-up questions
                  <span className="ml-1.5 font-normal text-ink-faint">
                    · {repo.followUpStandard().filter((q) => q.enabled).length} standard
                    {opening.followUpQuestions.length > 0 && ` + ${opening.followUpQuestions.length} for this job`}
                  </span>
                </span>
                <svg
                  className="h-5 w-5 shrink-0 text-ink-soft transition-transform duration-200 group-open:rotate-180"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                Always asked: {repo.followUpStandard().filter((q) => q.enabled).map((q) => q.label.toLowerCase()).join(", ")}.
              </p>
            </summary>
            <div className="mt-3 border-t border-rule pt-3">
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                Add anything else this job needs, one per line.
              </p>
              {canManage ? (
                <form action={setOpeningQuestions} className="mt-2 grid gap-2">
                  <input type="hidden" name="openingId" value={id} />
                  <textarea
                    name="questions"
                    rows={3}
                    defaultValue={opening.followUpQuestions.map((q) => q.label).join("\n")}
                    placeholder={"Valid driving licence?\nWilling to travel to Bangladesh?"}
                    className="w-full rounded border border-rule bg-paper px-2.5 py-2 text-[12.5px]"
                  />
                  <div>
                    <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
                  </div>
                </form>
              ) : (
                <ul className="mt-2 list-disc pl-5 text-[12px] text-ink-soft">
                  {opening.followUpQuestions.map((q) => (
                    <li key={q.id}>{q.label}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </div>
      )}

      {s === "ta_follow_up" && canAct && workLocationId !== "" && <HhUpload key={workLocationId} openingId={id} workLocationId={workLocationId} />}

      {s === "ta_follow_up" && (
        <AskQuestion
          openingId={id}
          standard={repo.followUpStandard().filter((q) => q.enabled).map((q) => q.label)}
          custom={opening.followUpQuestions.map((q) => q.label)}
          canAsk={canManage}
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
            // By the day each candidate was sent for review, so the Director
            // sees today's batch apart from yesterday's (30 Sep).
            groupByDay={s === "director_review" ? (a) => a.lastStageChangedAt : undefined}
          />
        </div>
      </div>
    </>
  );
}
