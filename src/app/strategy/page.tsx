import Link from "next/link";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { pageUser } from "@/lib/session";
import { allows } from "@/lib/auth";
import { StatRow } from "@/components/StatRow";
import { countsOf, plannerByTa, type StrategyCounts } from "@/lib/strategyPlanner";

/**
 * The Strategy Planner (8 Oct) — for TA Leads, directors and admins.
 *
 * Every job still being worked, under the TA who has it. Opening a job is where
 * the lead gives that TA strategies; this page is the overview of who has been
 * given what, and how far they have got.
 */
export default async function StrategyPlannerPage() {
  await primeStore();
  const user = await pageUser("strategy.assign");
  const rows = repo.strategyAssignments();
  const { groups, unstaffed } = plannerByTa(repo.openings(), repo.users(), rows);
  const all = countsOf(rows);
  const canManage = allows(user, "strategy.manage");
  const jobsInPlay = new Set(groups.flatMap((g) => g.jobs.map((j) => j.opening.id))).size + unstaffed.length;

  return (
    <main className="mx-auto max-w-[1000px] px-4 pb-24 pt-8 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Strategy Planner</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">
            Every job being worked, under its TA. Open a job to put TAs on its strategies and strike through the ones
            that cannot be used there; the TAs fill in what they did and submit it, and you read it on the job.
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
          { n: jobsInPlay, label: "Jobs being worked" },
          { n: all.assigned, label: "Strategies assigned" },
          { n: all.done, label: "Used, as submitted" },
        ]}
      />

      {groups.length === 0 && unstaffed.length === 0 ? (
        <p className="rounded-xl border border-rule bg-surface px-6 py-12 text-center text-[13px] text-ink-faint">
          No job is being worked right now.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.ta.id} className="overflow-hidden rounded-xl border border-rule bg-surface">
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-5 py-3.5">
                <h2 className="text-[14px] font-semibold">{g.ta.name}</h2>
                <span className="text-[12px] text-ink-faint">
                  {g.jobs.length} {g.jobs.length === 1 ? "job" : "jobs"} · <Progress c={g.counts} />
                </span>
              </header>
              <ul className="divide-y divide-rule">
                {g.jobs.map(({ opening, counts }) => (
                  <li key={opening.id}>
                    <Link href={`/strategy/${opening.id}`} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3 transition-colors hover:bg-tag">
                      <span className="min-w-0">
                        <span className="text-[13px] font-medium">{opening.title}</span>
                        <span className="ml-2 text-[12px] text-ink-faint">{repo.client(opening.clientId)?.name ?? ""}</span>
                        {opening.status === "on_hold" && <span className="ml-2 rounded-full bg-tag px-2 py-0.5 text-[10.5px] text-ink-soft">On hold</span>}
                      </span>
                      <span className="text-[12px] text-ink-soft">
                        {counts.assigned === 0 ? <span className="text-warn">No strategies yet</span> : <Progress c={counts} />}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {unstaffed.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-dashed border-rule-strong bg-surface">
              <header className="border-b border-rule px-5 py-3.5">
                <h2 className="text-[14px] font-semibold">No TA on these yet</h2>
                <p className="mt-0.5 text-[12px] text-ink-faint">Put a TA on the job first (Overview, then team) and it will appear under them.</p>
              </header>
              <ul className="divide-y divide-rule">
                {unstaffed.map((o) => (
                  <li key={o.id} className="px-5 py-3 text-[13px]">
                    <Link href={`/openings/${o.id}`} className="font-medium hover:underline">{o.title}</Link>
                    <span className="ml-2 text-[12px] text-ink-faint">{repo.client(o.clientId)?.name ?? ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

/** "3 assigned · 1 used", leaving out what is zero. Struck-through strategies are not progress. */
function Progress({ c }: { c: StrategyCounts }) {
  if (c.assigned === 0) return <span>none assigned</span>;
  const parts = [`${c.assigned} assigned`, c.done ? `${c.done} used` : null].filter(Boolean);
  return <span className="tabular">{parts.join(" · ")}</span>;
}
