import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { scopeStrategies } from "@/lib/visibility";
import { ProjectHeader } from "../ProjectHeader";
import { requireSourcingSeat } from "../sourcingGate";
import { StatRow } from "@/components/StatRow";
import { StrategyTaTable, type TaStrategyRow } from "@/components/StrategyTaTable";
import { colomboDateValue } from "@/lib/calendar";
import { countsOf, dayLabel, proofsVisibleTo, strategyTable } from "@/lib/strategyPlanner";

/**
 * Strategies on this job (8 Oct), as the TA sees them: the strategies their TA
 * Lead put them on, and the ones struck through for the job (crossed out, so they
 * know not to use them). They fill in what they did and submit it.
 *
 * Rows are narrowed by `scopeStrategies` on every read, not by what this page
 * chooses to draw. A lead or director who opens the page is sent to the Strategy
 * Planner, where the same table is theirs to plan and read.
 */
export default async function OpeningStrategiesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await primeStore({ openingId: id });
  await requireSourcingSeat(id);
  const opening = repo.opening(id);
  if (!opening) notFound();
  const user = await getCurrentUser();
  const isLead = allows(user, "strategy.assign");

  const visible = scopeStrategies(repo.strategyAssignments(id), user);
  const mine = visible.filter((r) => r.doneBy.includes(user.id) && !r.notApplicable);
  // Progress is on the TA's own rows; the struck-through count is the job's.
  const counts = { ...countsOf(mine), notApplicable: visible.filter((r) => r.notApplicable).length };
  const nameOf = (uid: string) => repo.user(uid)?.name ?? "Someone";

  // Only the rows this person may see become lines: assigned ones and struck-through ones.
  const lines = strategyTable(repo.strategies(true), visible).filter((l) => l.row);
  const rows: TaStrategyRow[] = lines.map(({ strategy, row }) => {
    const r = row!;
    return {
      rowId: r.id,
      name: strategy.name,
      description: strategy.description,
      struck: r.notApplicable,
      doneBy: r.doneBy.map(nameOf),
      assignedLabel: dayLabel(r.assignedAt),
      doneAtValue: colomboDateValue(r.doneAt),
      used: r.doneAt !== null,
      note: r.note ?? "",
      submittedLabel: r.submittedAt ? `Submitted ${dayLabel(r.submittedAt)}` : null,
      proofs: proofsVisibleTo(r, user).map((p) => ({ id: p.id, submitted: p.submittedAt !== null })),
    };
  });

  return (
    <>
      <h1 className="text-[21px] font-semibold tracking-tight">Strategies</h1>
      <ProjectHeader openingId={id} />

      {isLead ? (
        <p className="rounded-xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
          The strategy table for this job is in the{" "}
          <Link href={`/strategy/${id}`} className="font-medium text-brand hover:underline">Strategy Planner</Link>:
          put TAs on strategies, strike through the ones that cannot be used here, and read what the TAs submit.
        </p>
      ) : (
        <>
          <StatRow
            items={[
              { n: counts.assigned, label: "Given to you" },
              { n: counts.done, label: "Used, as submitted" },
              { n: counts.notApplicable, label: "Not for this job" },
            ]}
          />
          {rows.length === 0 ? (
            <div className="rounded-xl border border-rule bg-surface px-8 py-14 text-center">
              <p className="text-[14px] font-medium">No strategies for you on this job yet</p>
              <p className="mx-auto mt-1.5 max-w-[48ch] text-[12.5px] leading-relaxed text-ink-faint">
                Your TA Lead has not put you on any strategy for this job. They will appear here, and you will get a notification.
              </p>
            </div>
          ) : (
            <StrategyTaTable openingId={id} rows={rows} />
          )}
        </>
      )}
    </>
  );
}
