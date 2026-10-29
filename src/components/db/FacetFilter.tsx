"use client";

import Link, { useLinkStatus } from "next/link";

export type FacetChoice = { key: string; label: string; count: number; on: boolean; href: string };

const SHOWN = 10;

/** Shown inside a Link while its update is on the way; the old list stays until then. */
function Waiting() {
  const { pending } = useLinkStatus();
  return pending ? (
    <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand/30 border-t-brand" />
  ) : null;
}

function Choice({ o }: { o: FacetChoice }) {
  return (
    <li>
      <Link
        href={o.href}
        scroll={false}
        aria-pressed={o.on}
        className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors hover:bg-tag ${o.on ? "bg-brand-soft" : ""}`}
      >
        <span
          aria-hidden="true"
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none ${
            o.on ? "border-brand bg-brand text-white" : "border-rule-strong bg-surface"
          }`}
        >
          {o.on ? "✓" : ""}
        </span>
        <span className={`min-w-0 flex-1 truncate ${o.on ? "font-medium text-brand" : "text-ink"}`} title={o.label}>
          {o.label}
        </span>
        <Waiting />
        <span className="tabular text-[11.5px] text-ink-faint">{o.count.toLocaleString()}</span>
      </Link>
    </li>
  );
}

/**
 * One tick list beside the results (29 Oct), in the look of the Level filter.
 * Ticks are plain links, so a filtered list has its own address. The ten
 * biggest options show; the rest sit under "Show more", and a ticked option is
 * always in view.
 */
export function FacetFilter({
  label,
  options,
  clearHref,
  open = false,
}: {
  label: string;
  options: FacetChoice[];
  /** The address with this list's ticks cleared. */
  clearHref: string;
  open?: boolean;
}) {
  if (options.length === 0) return null;
  const ticked = options.filter((o) => o.on).length;
  const head = options.filter((o, i) => i < SHOWN || o.on);
  const rest = options.filter((o) => !head.includes(o));
  return (
    <details className="rounded-xl border border-rule bg-surface p-4" open={open || ticked > 0}>
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">{label}</h2>
        {ticked > 0 && (
          <Link href={clearHref} scroll={false} className="text-[11.5px] font-medium text-brand hover:underline">
            Clear
          </Link>
        )}
      </summary>
      <ul className="mt-2.5 flex flex-col gap-0.5">
        {head.map((o) => (
          <Choice key={o.key} o={o} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer px-2 py-1 text-[11.5px] font-medium text-brand hover:underline">Show {rest.length} more</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {rest.map((o) => (
              <Choice key={o.key} o={o} />
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}
