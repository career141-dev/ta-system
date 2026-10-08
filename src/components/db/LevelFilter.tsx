import Link from "next/link";
import type { LevelOption } from "@/lib/levels";

/**
 * The levels the matched people are at, as a list to tick (8 Oct). A Senior
 * Software Engineer search lists Senior, Mid-level, Junior / Associate… with
 * how many people each holds, nearest the job's own level first. Nothing ticked
 * shows everyone; ticking narrows the list to those levels. Plain links, so a
 * filtered list has its own address and survives a reload or a share.
 *
 * Counts are of the people this search found, before the filter, so a ticked
 * level never makes the others read zero.
 */
export function LevelFilter({
  options,
  picked,
  hrefFor,
  jobTitle,
}: {
  options: LevelOption[];
  picked: ReadonlySet<string>;
  /** The search with one level ticked or unticked; no argument clears them. */
  hrefFor: (toggle?: string) => string;
  jobTitle: string | null;
}) {
  // One level, or none: there is nothing to choose between.
  if (options.length < 2) return null;
  return (
    <section className="rounded-xl border border-rule bg-surface p-4" aria-label="Filter by level">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Level</h2>
        {picked.size > 0 && (
          <Link href={hrefFor()} className="text-[11.5px] font-medium text-brand hover:underline">
            Show all
          </Link>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
        {jobTitle ? `The levels matched for ${jobTitle}.` : "The levels these people are at."} Tick the ones you want to see.
      </p>
      <ul className="mt-2.5 flex flex-col gap-0.5">
        {options.map((o) => {
          const on = picked.has(o.key);
          return (
            <li key={o.key}>
              <Link
                href={hrefFor(o.key)}
                aria-pressed={on}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors hover:bg-tag ${on ? "bg-brand-soft" : ""}`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
                    on ? "border-brand bg-brand text-white" : "border-rule-strong bg-surface"
                  }`}
                >
                  {on ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={on ? "font-medium text-brand" : "text-ink"}>{o.name}</span>
                  {o.note && <span className="block text-[11px] text-ink-faint">{o.note}</span>}
                </span>
                <span className="tabular text-[11.5px] text-ink-faint">{o.count.toLocaleString()}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
