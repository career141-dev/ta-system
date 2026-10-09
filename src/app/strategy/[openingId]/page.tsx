import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { pageUser } from "@/lib/session";
import { inputClass } from "@/components/form";
import { SubmitButton } from "@/components/Submit";
import { saveStrategy } from "@/app/actions";
import { StrategyLeadTable } from "@/components/StrategyLeadTable";
import { leadLine, strategyTable } from "@/lib/strategyPlanner";
import { isTa } from "@/lib/auth";

/**
 * One job in the Strategy Planner (8 Oct): its table of strategies, one row each.
 * The same table opens in place on the Strategy Planner (9 Oct).
 *
 * The lead ticks the strategies the TAs should use, puts TAs on them ("Done
 * by"), keeps the dates and a note, or strikes one through when it cannot be
 * used on this job. What a TA submits (the date, the note, the proof pictures)
 * appears on the row.
 */
export default async function StrategyJobPage({ params }: { params: Promise<{ openingId: string }> }) {
  const { openingId } = await params;
  await primeStore({ openingId });
  await pageUser("strategy.assign");
  const opening = repo.opening(openingId);
  if (!opening) notFound();

  const lines = strategyTable(repo.strategies(true), repo.strategyAssignments(openingId));
  const tas = opening.assignedTaIds
    .map((id) => repo.user(id))
    .filter((u): u is NonNullable<typeof u> => !!u && isTa(u) && u.isActive);
  const nameOf = (id: string | null) => (id ? repo.user(id)?.name ?? "Someone" : "");
  const headings = [...new Set(repo.strategies().map((s) => s.group).filter((g): g is string => !!g))];

  return (
    <main className="mx-auto max-w-[1180px] px-4 pb-24 pt-8 sm:px-6">
      <Link href="/strategy" className="text-[12.5px] text-ink-soft hover:text-ink">← Strategy Planner</Link>
      <h1 className="mt-3 text-[22px] font-semibold tracking-tight">{opening.title}</h1>
      <p className="mt-1 text-[13px] text-ink-soft">
        {repo.client(opening.clientId)?.name ?? ""}
        {opening.status === "on_hold" ? " · on hold" : ""} ·{" "}
        {tas.length ? `TAs on it: ${tas.map((t) => t.name).join(", ")}` : "no TA on it yet"} ·{" "}
        <Link href={`/openings/${opening.id}`} className="text-brand hover:underline">Open the job</Link>
      </p>
      <p className="mt-2 max-w-[78ch] text-[12.5px] leading-relaxed text-ink-faint">
        Tick the strategies the TAs on this job should use and put a TA on each. The TAs see only the ticked ones; N/A
        crosses one out for the job. Changes save as you make them, and what a TA submits appears on its row.
      </p>

      {tas.length === 0 && (
        <p className="mt-5 rounded-lg bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
          No TA is on this job yet, so there is nobody to put on a strategy. Add one under Overview, then Change the team.
        </p>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-rule bg-surface">
        <StrategyLeadTable openingId={openingId} tas={tas.map((t) => ({ id: t.id, name: t.name }))} lines={lines.map((l) => leadLine(l, nameOf))} />
        <div className="border-t border-rule bg-paper/60 px-3 py-3">
          <form action={saveStrategy} className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-ink-soft">Add a strategy to the list:</span>
            <input name="name" required maxLength={120} placeholder="Name" aria-label="New strategy name" className={`${inputClass} !w-[260px] !py-1.5 !text-[12.5px]`} />
            <input name="group" maxLength={60} list="strategy-headings" placeholder="Heading (optional)" aria-label="Heading" className={`${inputClass} !w-[170px] !py-1.5 !text-[12.5px]`} />
            <datalist id="strategy-headings">{headings.map((h) => <option key={h} value={h} />)}</datalist>
            <SubmitButton pendingLabel="Adding…" className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-60">
              Add
            </SubmitButton>
            <span className="text-[11.5px] text-ink-faint">It appears on every job's table. <Link href="/strategy/manage" className="text-brand hover:underline">Manage the list</Link></span>
          </form>
        </div>
      </div>
    </main>
  );
}
