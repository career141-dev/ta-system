/**
 * Three numbers in bordered tiles, the way Recruiter's Spotlights work. Boxed
 * rather than floating so the top of the page has structure instead of a gap.
 */
export function StatRow({ items }: { items: { n: number | string; label: string }[] }) {
  return (
    <div className="mb-6 grid grid-cols-3 gap-2 sm:gap-4">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 rounded-xl border border-rule bg-surface px-3 py-3 sm:px-5 sm:py-4">
          <div className="tabular truncate text-[19px] font-semibold leading-none sm:text-[24px]">{i.n}</div>
          <div className="mt-2 text-[11.5px] text-ink-soft sm:text-[12.5px]">{i.label}</div>
        </div>
      ))}
    </div>
  );
}
