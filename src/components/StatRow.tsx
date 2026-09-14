/**
 * Three numbers in bordered tiles, the way Recruiter's Spotlights work. Boxed
 * rather than floating so the top of the page has structure instead of a gap.
 */
export function StatRow({ items }: { items: { n: number | string; label: string }[] }) {
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl border border-rule bg-surface px-5 py-4">
          <div className="tabular text-[24px] font-semibold leading-none">{i.n}</div>
          <div className="mt-2 text-[12.5px] text-ink-soft">{i.label}</div>
        </div>
      ))}
    </div>
  );
}
