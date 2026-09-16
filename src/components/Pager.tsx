import Link from "next/link";

/**
 * Previous / page numbers (up to ten) / Next — the pager the Database results page already
 * used, shared so every list pages the same way. Renders nothing when the list
 * fits on one page.
 */
export function Pager({
  page,
  pageSize,
  total,
  href,
  className = "mt-5",
  scroll = true,
}: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
  className?: string;
  /** false on a screen with several lists, so paging one does not jump to the top. */
  scroll?: boolean;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);

  // Up to ten page numbers at once, moving with the current page. Beyond ten,
  // the first and last pages stay reachable with a gap marker between.
  const WINDOW = 10;
  let from = Math.max(1, current - Math.floor(WINDOW / 2) + 1);
  const to = Math.min(pages, from + WINDOW - 1);
  from = Math.max(1, to - WINDOW + 1);
  const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const pill = "grid h-8 min-w-8 place-items-center rounded-full border px-2.5 tabular";
  const number = (n: number) =>
    n === current ? (
      <span key={n} aria-current="page" className={`${pill} border-brand bg-brand font-medium text-white`}>
        {n}
      </span>
    ) : (
      <Link key={n} href={href(n)} scroll={scroll} aria-label={`Page ${n}`} className={`${pill} border-rule text-ink-soft hover:bg-tag hover:text-ink`}>
        {n}
      </Link>
    );
  const gap = (key: string) => (
    <span key={key} className="px-1 text-ink-faint" aria-hidden="true">
      …
    </span>
  );

  return (
    <nav aria-label="Pages" className={`${className} flex flex-wrap items-center justify-center gap-1.5 text-[12.5px]`}>
      {current > 1 ? (
        <Link href={href(current - 1)} scroll={scroll} className="mr-1.5 rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Previous</Link>
      ) : (
        <span className="mr-1.5 rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Previous</span>
      )}
      {from > 1 && number(1)}
      {from > 2 && gap("start")}
      {numbers.map(number)}
      {to < pages - 1 && gap("end")}
      {to < pages && number(pages)}
      {current < pages ? (
        <Link href={href(current + 1)} scroll={scroll} className="ml-1.5 rounded-full border border-rule px-3.5 py-1.5 hover:bg-tag">Next</Link>
      ) : (
        <span className="ml-1.5 rounded-full border border-rule px-3.5 py-1.5 text-ink-faint">Next</span>
      )}
    </nav>
  );
}
