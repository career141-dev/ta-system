import Link from "next/link";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { pageUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { StatRow } from "@/components/StatRow";
import { StrategyLeadTable } from "@/components/StrategyLeadTable";
import { countsOf, dayLabel, leadLine, plannerJobs, strategyTable, type StrategyCounts } from "@/lib/strategyPlanner";

/**
 * The Strategy Planner (8 Oct) — for TA Leads, directors and admins.
 *
 * One table of every job still being worked (9 Oct, the lead's layout): client,
 * position, the day it was assigned, its TAs and how far its strategies have
 * got. A job opens in place to its strategies, where the lead ticks the ones
 * the TAs should use, puts TAs on them and keeps the dates and notes.
 */
export default async function StrategyPlannerPage({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job } = await searchParams;
  await primeStore();
  const user = await pageUser("strategy.assign");
  const rows = repo.strategyAssignments();
  const clientName = (id: string) => repo.client(id)?.name ?? "";
  const jobs = plannerJobs(repo.openings(), repo.users(), rows, clientName);
  const all = countsOf(rows.filter((r) => jobs.some((j) => j.opening.id === r.openingId)));
  const canManage = allows(user, "strategy.manage");
  const strategies = repo.strategies(true);
  const nameOf = (id: string | null) => (id ? repo.user(id)?.name ?? "Someone" : "");
  const allUsers = repo
    .users()
    .filter((u) => u.isActive && u.role !== "client")
    .map((u) => ({ id: u.id, name: u.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const th = "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint";
  const cols = "grid grid-cols-[minmax(150px,1.2fr)_minmax(200px,2fr)_120px_minmax(130px,1fr)_150px] items-center gap-x-4";

  return (
    <main className="mx-auto max-w-[1280px] px-4 pb-24 pt-8 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Strategy Planner</h1>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-soft">
            Open a job to tick the strategies its TAs should use, put a TA on each and keep the dates and a note. The TAs
            see only the ticked ones; N/A crosses one out for the job. Changes save as you make them.
          </p>
        </div>
        {canManage && (
          <Link href="/strategy/manage" className="rounded-full border border-rule px-4 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-brand-line hover:text-brand">
            Manage list
          </Link>
        )}
      </div>

      <StatRow
        items={[
          { n: jobs.length, label: "Jobs being worked" },
          { n: all.assigned, label: "Strategies in use" },
          { n: all.done, label: "Done" },
        ]}
      />

      {jobs.length === 0 ? (
        <p className="rounded-xl border border-rule bg-surface px-6 py-12 text-center text-[13px] text-ink-faint">
          No job is being worked right now.
        </p>
      ) : strategies.length === 0 ? (
        <p className="rounded-xl border border-rule bg-surface px-6 py-12 text-center text-[13px] text-ink-faint">
          The strategy list is empty.{" "}
          {canManage && <Link href="/strategy/manage" className="text-brand hover:underline">Add the desk&apos;s strategies</Link>}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
          <div className="min-w-[860px]">
            <div className={`${cols} border-b border-rule bg-paper`}>
              <span className={th}>Client</span>
              <span className={th}>Position</span>
              <span className={th}>Date assigned</span>
              <span className={th}>Assignee</span>
              <span className={th}>Progress</span>
            </div>
            {jobs.map(({ opening, tas, counts }) => {
              const lines = strategyTable(strategies, rows.filter((r) => r.openingId === opening.id)).map((l) => leadLine(l, nameOf));
              return (
                <details key={opening.id} open={job === opening.id} className="group border-b border-rule last:border-b-0">
                  <summary className={`${cols} cursor-pointer list-none py-3 transition-colors hover:bg-tag group-open:bg-tag/60 [&::-webkit-details-marker]:hidden`}>
                    <span className="flex min-w-0 items-center gap-2 px-4 text-[12.5px] uppercase tracking-wide text-ink-soft">
                      <span aria-hidden className="text-[10px] text-ink-faint transition-transform group-open:rotate-90">▶</span>
                      <span className="truncate">{clientName(opening.clientId)}</span>
                    </span>
                    <span className="min-w-0 px-4 text-[13px] font-medium uppercase tracking-wide">
                      {opening.title}
                    </span>
                    <span className="px-4 text-[12.5px] text-ink-soft tabular">{dayLabel(opening.assignedAt)}</span>
                    <span className="min-w-0 truncate px-4 text-[12.5px]">
                      {tas.length ? tas.map((t) => t.name).join(", ") : <span className="text-warn">No TA yet</span>}
                    </span>
                    <span className="px-4"><Progress c={counts} /></span>
                  </summary>
                  <div className="border-t border-rule bg-paper/40">
                    <StrategyLeadTable openingId={opening.id} users={allUsers} lines={lines} />
                    <p className="flex flex-wrap gap-x-4 px-4 pb-3 text-[11.5px] text-ink-faint">
                      <Link href={`/strategy/${opening.id}`} className="text-brand hover:underline">Open on its own page</Link>
                      <Link href={`/openings/${opening.id}`} className="text-brand hover:underline">Open the job</Link>
                    </p>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}

/** "2 of 6 done" with a bar; struck-through strategies are not progress. */
function Progress({ c }: { c: StrategyCounts }) {
  if (c.assigned === 0) return <span className="text-[12px] text-ink-faint">Not started</span>;
  const pct = Math.round((c.done / c.assigned) * 100);
  return (
    <span className="flex flex-col gap-1">
      <span className="text-[11.5px] text-ink-soft tabular">{c.done} of {c.assigned} done</span>
      <span className="h-1.5 w-full overflow-hidden rounded-full bg-rule">
        <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
