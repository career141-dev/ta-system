/**
 * Everything people wrote about an opening, read-only: the lead's brief and each
 * TA's notes. Shown wherever the job is open, whatever state its JD is in, so
 * the notes do not disappear for the TA (1 Oct).
 */
export type BriefEntry = { id: string; author: string; isLead: boolean; notes: string; at: string };

export function OpeningBrief({ entries, className = "" }: { entries: BriefEntry[]; className?: string }) {
  if (entries.length === 0) return null;
  return (
    <section className={`overflow-hidden rounded-2xl border border-rule bg-surface ${className}`}>
      <div className="border-b border-rule px-7 py-4">
        <h2 className="text-[13.5px] font-semibold">Brief and notes</h2>
      </div>
      {entries.map((b) => (
        <div key={b.id} className="border-b border-rule px-7 py-5 last:border-b-0">
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-soft">
            {b.isLead ? "Brief" : "Notes"} from {b.author}{" "}
            <span className="font-normal normal-case tracking-normal text-ink-faint">· {b.at}</span>
          </p>
          <p className="whitespace-pre-wrap text-[13px] leading-[1.75] text-ink">{b.notes}</p>
        </div>
      ))}
    </section>
  );
}
