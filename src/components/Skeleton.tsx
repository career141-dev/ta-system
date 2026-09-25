/**
 * The shape of a page while it loads (the routes' loading.tsx).
 *
 * A click on a list row used to leave the old page on screen, unchanged, until
 * the new one had fully loaded — long enough to click again (25 Sep). This is
 * drawn at once, in the new page's place.
 */
export function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-tag motion-reduce:animate-none ${className}`} />;
}

/** A heading and a column of cards: the lists (openings, clients, results). */
export function PageSkeleton({ rows = 5, wide = true }: { rows?: number; wide?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className={wide ? "mx-auto max-w-[1180px] px-8 py-9" : ""}>
      <Bone className="h-7 w-56" />
      <Bone className="mt-3 h-4 w-80" />
      <div className="mt-8 flex flex-col gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="rounded-xl border border-rule bg-surface px-7 py-5">
            <Bone className="h-3 w-28" />
            <Bone className="mt-2.5 h-5 w-72 max-w-full" />
            <Bone className="mt-3 h-3.5 w-96 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
