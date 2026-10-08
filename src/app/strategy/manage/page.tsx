import Link from "next/link";
import { repo } from "@/data/store";
import { primeStore } from "@/data/prime";
import { pageUser } from "@/lib/session";
import { inputClass } from "@/components/form";
import { SubmitButton } from "@/components/Submit";
import { saveStrategy, setStrategyActive } from "@/app/actions";

/**
 * The list of strategies a lead can choose from (8 Oct), edited here. A
 * strategy that is retired leaves the dropdown but stays on whatever it was
 * already given for, so nothing a TA is working on disappears.
 */
export default async function ManageStrategiesPage() {
  await primeStore();
  await pageUser("strategy.manage");
  const all = repo.strategies(true);
  const active = all.filter((s) => s.active);
  const retired = all.filter((s) => !s.active);
  const given = (id: string) => repo.strategyAssignments().filter((a) => a.strategyId === id).length;
  const headings = [...new Set(active.map((s) => s.group).filter((g): g is string => !!g))];

  return (
    <main className="mx-auto max-w-[860px] px-4 pb-24 pt-8 sm:px-6">
      <Link href="/strategy" className="text-[12.5px] text-ink-soft hover:text-ink">← Strategy Planner</Link>
      <h1 className="mt-3 text-[22px] font-semibold tracking-tight">Strategy list</h1>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">
        The strategies a TA Lead can choose from when planning a job. Retiring one takes it out of the dropdown; ones
        already given stay as they are.
      </p>

      <section className="mt-6 rounded-xl border border-rule bg-surface p-5">
        <h2 className="text-[13.5px] font-semibold">Add a strategy</h2>
        <form action={saveStrategy} className="mt-3 flex flex-col gap-2.5">
          <input name="name" required maxLength={120} placeholder="Name" aria-label="Name" className={inputClass} />
          <input name="description" maxLength={600} placeholder="What it means, in a sentence (optional)" aria-label="Description" className={inputClass} />
          <input name="group" maxLength={60} list="strategy-groups" placeholder="Heading to list it under (optional)" aria-label="Heading" className={inputClass} />
          <datalist id="strategy-groups">
            {headings.map((h) => <option key={h} value={h} />)}
          </datalist>
          <div>
            <SubmitButton pendingLabel="Adding…" className="rounded-full bg-brand px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60">
              Add to the list
            </SubmitButton>
          </div>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="mb-2.5 text-[13.5px] font-semibold">On the list <span className="font-normal text-ink-faint">· {active.length}</span></h2>
        {active.length === 0 ? (
          <p className="rounded-xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-faint">Nothing on the list yet. Add the first one above.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {active.map((s) => (
              <li key={s.id} className="rounded-xl border border-rule bg-surface p-4">
                <form action={saveStrategy} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={s.id} />
                  <input name="name" required maxLength={120} defaultValue={s.name} aria-label="Name" className={inputClass} />
                  <input name="description" maxLength={600} defaultValue={s.description ?? ""} placeholder="Description (optional)" aria-label="Description" className={inputClass} />
                  <input name="group" maxLength={60} list="strategy-groups" defaultValue={s.group ?? ""} placeholder="Heading (optional)" aria-label="Heading" className={inputClass} />
                  <div className="flex flex-wrap items-center gap-3">
                    <SubmitButton tone="dark" pendingLabel="Saving…" className="rounded-full border border-brand-line px-4 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-60">
                      Save
                    </SubmitButton>
                    <span className="text-[11.5px] text-ink-faint">Given {given(s.id)} {given(s.id) === 1 ? "time" : "times"}</span>
                  </div>
                </form>
                <form action={setStrategyActive} className="mt-2 border-t border-rule pt-2">
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="active" value="0" />
                  <SubmitButton tone="dark" pendingLabel="Retiring…" className="text-[12px] text-ink-faint hover:text-warn disabled:opacity-60">
                    Retire from the list
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {retired.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2.5 text-[13.5px] font-semibold">Retired <span className="font-normal text-ink-faint">· {retired.length}</span></h2>
          <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
            {retired.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <span className="text-[13px] text-ink-soft">{s.name}<span className="ml-2 text-[11.5px] text-ink-faint">given {given(s.id)} {given(s.id) === 1 ? "time" : "times"}</span></span>
                <form action={setStrategyActive}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="active" value="1" />
                  <SubmitButton tone="dark" pendingLabel="Restoring…" className="text-[12px] font-medium text-brand hover:underline disabled:opacity-60">
                    Bring back
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
