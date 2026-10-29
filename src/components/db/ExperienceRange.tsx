"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Years of experience as a range (29 Oct): only people inside it are listed.
 *
 * Two native range inputs on one track, so the keyboard and screen readers work
 * with no library. It changes the address when the thumb is let go, not while
 * it moves, and the list swaps in place when the new one is ready.
 *
 * Keyed by the server on its range, so it starts again from the address after
 * "Any" or a clear.
 */
export function ExperienceRange({
  lo,
  hi,
  max,
  base,
  rest,
  hidden,
}: {
  lo: number;
  hi: number;
  /** The top of the slider; it reads "N+". */
  max: number;
  base: string;
  /** The address's own query, less the range and the page. */
  rest: string;
  /** People without years on record, hidden while the range is narrow. */
  hidden: number;
}) {
  const router = useRouter();
  const [a, setA] = useState(lo);
  const [b, setB] = useState(hi);
  const [pending, start] = useTransition();
  const narrow = a > 0 || b < max;

  const commit = (x: number, y: number) => {
    const p = new URLSearchParams(rest);
    if (x > 0 || y < max) {
      p.set("xmin", String(x));
      p.set("xmax", String(y));
    }
    start(() => router.replace(`${base}?${p.toString()}`, { scroll: false }));
  };

  const thumb =
    "pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent outline-none " +
    "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow " +
    "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:bg-brand " +
    "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-brand-line";
  const pct = (n: number) => `${(n / max) * 100}%`;

  return (
    <section className="rounded-xl border border-rule bg-surface p-4" aria-label="Filter by years of experience">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Experience</h2>
        {narrow && (
          <button type="button" onClick={() => { setA(0); setB(max); commit(0, max); }} className="text-[11.5px] font-medium text-brand hover:underline">
            Any
          </button>
        )}
      </div>
      <p className="tabular mt-1 text-[12.5px] text-ink">
        {narrow ? `${a} – ${b >= max ? `${max}+` : b} years` : "Any number of years"}
        {pending && <span className="ml-2 text-[11.5px] text-ink-faint">Updating…</span>}
      </p>
      <div className="relative mt-3 h-5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-rule" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand" style={{ left: pct(a), right: `calc(100% - ${pct(b)})` }} />
        <input
          type="range"
          min={0}
          max={max}
          value={a}
          aria-label="Fewest years"
          className={thumb}
          // On top when both thumbs sit at the far end, so the lower one can still be moved.
          style={{ zIndex: a >= max - 1 ? 5 : 3 }}
          onChange={(e) => setA(Math.min(Number(e.target.value), b))}
          onPointerUp={() => commit(a, b)}
          onKeyUp={() => commit(a, b)}
        />
        <input
          type="range"
          min={0}
          max={max}
          value={b}
          aria-label="Most years"
          className={thumb}
          style={{ zIndex: 4 }}
          onChange={(e) => setB(Math.max(Number(e.target.value), a))}
          onPointerUp={() => commit(a, b)}
          onKeyUp={() => commit(a, b)}
        />
      </div>
      {hidden > 0 && (
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
          {hidden.toLocaleString()} {hidden === 1 ? "person" : "people"} with no years on record {hidden === 1 ? "is" : "are"} hidden while this is set.
        </p>
      )}
    </section>
  );
}
