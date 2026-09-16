import Link from "next/link";

/**
 * Previous / "Page N of M" / Next — the pager the Database results page already
 * used, shared so every list pages the same way. Renders nothing when the list
 * fits on one page.
 */
export function Pager({
  page,
  pageSize,
  total,
  href,
  className = "mt-5",
}: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
  className?: string;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return (
    <div className={`${className} flex items-center justify-center gap-3 text-[12.5px]`}>
      {current > 1 ? (
        <Link href={href(current - 1)} className="rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Previous</Link>
      ) : (
        <span className="rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Previous</span>
      )}
      <span className="tabular text-ink-soft">Page {current} of {pages}</span>
      {current < pages ? (
        <Link href={href(current + 1)} className="rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Next</Link>
      ) : (
        <span className="rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Next</span>
      )}
    </div>
  );
}
