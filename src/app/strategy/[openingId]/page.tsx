import Link from "next/link";
import { notFound } from "next/navigation";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { pageUser } from "@/lib/session";
import { inputClass } from "@/components/form";
import { SubmitButton } from "@/components/Submit";
import {
  addStrategyDoneBy,
  removeStrategyDoneBy,
  saveStrategy,
  setStrategyAssignedDate,
  setStrategyNotApplicable,
} from "@/app/actions";
import { colomboDateValue } from "@/lib/calendar";
import { dayLabel, proofsForLead, strategyTable } from "@/lib/strategyPlanner";

/**
 * One job in the Strategy Planner (8 Oct): its table of strategies, one row each.
 *
 * The lead puts TAs on a row ("Done by"), dates it, or strikes it through when
 * it cannot be used on this job. What the TA did (the date, the note, the
 * proof pictures) appears on the row once they submit it.
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
    .filter((u): u is NonNullable<typeof u> => !!u && u.role === "ta" && u.isActive);
  const nameOf = (id: string | null) => (id ? repo.user(id)?.name ?? "Someone" : "");
  const headings = [...new Set(repo.strategies().map((s) => s.group).filter((g): g is string => !!g))];

  const th = "border-b border-rule bg-paper px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint";
  const td = "border-b border-rule px-3 py-3 align-top text-[12.5px]";

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
        Put a TA on each strategy they should use. Strike through the ones that cannot be used on this job; the TAs see
        those crossed out. What a TA did appears on its row once they submit it.
      </p>

      {tas.length === 0 && (
        <p className="mt-5 rounded-lg bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
          No TA is on this job yet, so there is nobody to put on a strategy. Add one under Overview, then Change the team.
        </p>
      )}

      <div className="mt-6 overflow-x-auto rounded-xl border border-rule bg-surface">
        <table className="w-full min-w-[980px] border-collapse">
          <thead>
            <tr>
              <th className={th}>Strategy</th>
              <th className={th}>Done by</th>
              <th className={th}>Date assigned</th>
              <th className={th}>Date done</th>
              <th className={th}>Note</th>
              <th className={th}>Proof</th>
              <th className={th}>N/A</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ strategy, row }) => {
              const struck = !!row?.notApplicable;
              const free = tas.filter((t) => !row?.doneBy.includes(t.id));
              const proofs = row ? proofsForLead(row) : [];
              return (
                <tr key={strategy.id} className={struck ? "bg-paper/60" : ""}>
                  <td className={td}>
                    <span className={`font-medium ${struck ? "text-ink-faint line-through" : ""}`}>{strategy.name}</span>
                    {!strategy.active && <span className="ml-2 rounded-full bg-tag px-2 py-0.5 text-[10.5px] text-ink-soft">retired</span>}
                    {strategy.description && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{strategy.description}</span>}
                  </td>

                  <td className={td}>
                    <div className="flex flex-col gap-1.5">
                      {row?.doneBy.map((id) => (
                        <form key={id} action={removeStrategyDoneBy} className="flex items-center gap-1.5">
                          <input type="hidden" name="rowId" value={row.id} />
                          <input type="hidden" name="taId" value={id} />
                          <span className="rounded-full border border-rule bg-tag px-2.5 py-0.5 text-[12px]">{nameOf(id)}</span>
                          <SubmitButton tone="dark" title={`Take ${nameOf(id)} off`} aria-label={`Take ${nameOf(id)} off ${strategy.name}`} className="rounded px-1 text-[12px] text-ink-faint hover:bg-tag hover:text-ink disabled:opacity-60">
                            ✕
                          </SubmitButton>
                        </form>
                      ))}
                      {strategy.active && !struck && free.length > 0 && (
                        <form action={addStrategyDoneBy} className="flex items-center gap-1.5">
                          <input type="hidden" name="openingId" value={openingId} />
                          <input type="hidden" name="strategyId" value={strategy.id} />
                          <select name="taId" aria-label={`Put a TA on ${strategy.name}`} defaultValue="" required className={`${inputClass} !w-auto !py-1 !text-[12px]`}>
                            <option value="" disabled>+ Add</option>
                            {free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                          <SubmitButton tone="dark" pendingLabel="…" className="rounded-full border border-brand-line px-3 py-1 text-[11.5px] font-medium text-brand hover:bg-brand-soft disabled:opacity-60">
                            Add
                          </SubmitButton>
                        </form>
                      )}
                      {!row?.doneBy.length && (tas.length === 0 || struck) && <span className="text-ink-faint">—</span>}
                    </div>
                  </td>

                  <td className={td}>
                    {row && row.doneBy.length > 0 ? (
                      <form action={setStrategyAssignedDate} className="flex items-center gap-1.5">
                        <input type="hidden" name="rowId" value={row.id} />
                        <input type="date" name="date" defaultValue={colomboDateValue(row.assignedAt)} aria-label={`Date ${strategy.name} was assigned`} className={`${inputClass} !w-[140px] !py-1 !text-[12px]`} />
                        <SubmitButton tone="dark" pendingLabel="…" className="rounded-full border border-rule px-3 py-1 text-[11.5px] font-medium text-ink-soft hover:border-brand-line hover:text-brand disabled:opacity-60">
                          Save
                        </SubmitButton>
                      </form>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>

                  <td className={td}>
                    {row?.doneAt != null ? (
                      <>
                        <span className="font-medium">{dayLabel(row.doneAt)}</span>
                        {row.submittedAt && <span className="block text-[11px] text-ink-faint">Submitted by {nameOf(row.submittedBy)}, {dayLabel(row.submittedAt)}</span>}
                      </>
                    ) : row?.submittedAt ? (
                      <>
                        <span className="text-ink-faint">Not used yet</span>
                        <span className="block text-[11px] text-ink-faint">Submitted by {nameOf(row.submittedBy)}, {dayLabel(row.submittedAt)}</span>
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>

                  <td className={`${td} max-w-[280px]`}>
                    {row?.note ? <span className="whitespace-pre-wrap leading-snug">{row.note}</span> : <span className="text-ink-faint">—</span>}
                  </td>

                  <td className={td}>
                    {proofs.length === 0 ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {proofs.map((p) => (
                          <a key={p.id} href={`/api/strategy-proof?row=${row!.id}&proof=${encodeURIComponent(p.id)}`} target="_blank" rel="noopener noreferrer" title="Open the picture">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/strategy-proof?row=${row!.id}&proof=${encodeURIComponent(p.id)}`} alt={`Proof for ${strategy.name}`} width={56} height={56} className="h-14 w-14 rounded border border-rule object-cover" />
                          </a>
                        ))}
                      </div>
                    )}
                  </td>

                  <td className={td}>
                    <form action={setStrategyNotApplicable}>
                      <input type="hidden" name="openingId" value={openingId} />
                      <input type="hidden" name="strategyId" value={strategy.id} />
                      <input type="hidden" name="na" value={struck ? "0" : "1"} />
                      <SubmitButton tone="dark" pendingLabel="…" className={`rounded-full border px-3 py-1 text-[11.5px] font-medium disabled:opacity-60 ${struck ? "border-brand-line text-brand hover:bg-brand-soft" : "border-rule text-ink-soft hover:border-warn hover:text-warn"}`}>
                        {struck ? "Use again" : "Not for this job"}
                      </SubmitButton>
                    </form>
                  </td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={7} className="bg-paper/60 px-3 py-3">
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
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
