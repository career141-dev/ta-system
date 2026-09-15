import { convexQuery } from "@/lib/convexServer";
import { timeAt } from "@/lib/format";

/** What the recent AI calls captured, as the backend saved it. */

interface CallRow {
  id: string;
  status: string;
  calledAt: number | null;
  durationSeconds: number | null;
  consent: string | null;
  currentSalary: number | null;
  currentSalaryCurrency: string | null;
  expectedSalary: number | null;
  expectedSalaryCurrency: string | null;
  noticePeriodDays: number | null;
  transcript: string;
  endedReason: string | null;
}

const money = (n: number | null, c: string | null) => (n == null ? "—" : `${c ?? ""} ${n.toLocaleString()}`.trim());

export async function WebCallResults({ applicationId, actorId }: { applicationId: string; actorId: string }) {
  const calls = await convexQuery<CallRow[]>("ta/voice:callsFor", { actorId, applicationId }).catch(() => []);
  if (calls.length === 0) return null;
  return (
    <div className="rounded-xl border border-rule bg-surface">
      <div className="border-b border-rule px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
        AI call results
      </div>
      <ul className="divide-y divide-rule">
        {calls.map((c) => (
          <li key={c.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11.5px] text-ink-faint">
              <span>
                {c.status.replace("_", " ")}
                {c.consent ? ` · consent ${c.consent}` : ""}
                {c.durationSeconds ? ` · ${Math.round(c.durationSeconds)}s` : ""}
              </span>
              <span>{c.calledAt ? timeAt(c.calledAt) : ""}</span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-[12.5px]">
              <div><dt className="text-[11px] text-ink-faint">Current salary</dt><dd>{money(c.currentSalary, c.currentSalaryCurrency)}</dd></div>
              <div><dt className="text-[11px] text-ink-faint">Expected salary</dt><dd>{money(c.expectedSalary, c.expectedSalaryCurrency)}</dd></div>
              <div><dt className="text-[11px] text-ink-faint">Notice period</dt><dd>{c.noticePeriodDays == null ? "—" : `${c.noticePeriodDays} days`}</dd></div>
            </dl>
            {c.endedReason && <p className="mt-2 text-[11.5px] text-ink-faint">{c.endedReason}</p>}
            {c.transcript && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] text-ink-soft">Transcript</summary>
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-soft">{c.transcript}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
